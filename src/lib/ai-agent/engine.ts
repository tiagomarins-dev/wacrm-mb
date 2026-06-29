// ============================================================
// Engine do agente — roda o ciclo p/ UMA conversa madura (drenada do
// debounce pelo cron). Junta contexto, roda o loop LLM com tools de
// roteamento, aplica o pós-filtro (guardrail) e envia via engineSendText
// (R1 — reusa o sender canônico: resolve conexão + decrypt + persiste
// sender_type='bot' + retry phone-variant).
// Espelha a estrutura de executeAutomation (automations/engine.ts:175).
// Modo abertura (row.opening, via passo ai_reply): injeta a diretriz de
// cumprimento no prompt e SUPRIME o handoff nesta 1ª resposta.
// ============================================================
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText, engineSendTyping } from '@/lib/automations/meta-send'
import { resolveAssignedProfile, phoneAllowed } from './dispatch'
import { buildSystemPrompt, serializeRecentMessages } from './prompt'
import { listCursos, listSupportCategories } from './knowledge'
import { runAgentLoop, type AgentTelemetry } from './llm'
import { applyGuardrail, hasForbidden } from './guardrail'
import { recordAgentRun, type AgentRunInsert } from './telemetry'
import type { AiAgentConfig, AiAgentRun } from '@/types'

// Subconjunto da row de ai_agent_pending que o engine precisa.
export interface PendingRow {
  id: string
  account_id: string
  connection_id: string
  conversation_id: string
  contact_id: string
  last_inbound_message_id?: string | null // wamid p/ o "digitando..."
  // Modo abertura — cumprimenta+pergunta, sem handoff na 1ª resposta. Ausente
  // (caminho do cron) = comportamento normal.
  opening?: boolean
}

// Desfecho de uma execução do agente — retornado p/ o chamador logar o
// resultado REAL (o passo ai_reply antes gravava string fixa, mascarando
// no-ops). Espelha o enum de status da telemetria + os early-returns que
// saem antes de gravar run.
export type AiAgentOutcome =
  | 'ok' | 'no_reply' | 'blocked' | 'error' | 'superseded'
  | 'skipped:no_profile' | 'skipped:disabled' | 'skipped:no_history'

// Executa o agente p/ uma conversa: monta contexto, roda o loop, aplica
// guardrail, recheca controle humano e envia a resposta. Retorna o desfecho.
export async function runAiAgentForConversation(row: PendingRow): Promise<AiAgentOutcome> {
  const db = supabaseAdmin()

  // Perfil de IA responsável pela conversa — persona/modelo/tools/handoff vêm
  // DELE. null = não há perfil ativo atribuído (humano/órfão) → não atua.
  const profile = await resolveAssignedProfile(db, row.account_id, row.conversation_id)
  if (!profile) return 'skipped:no_profile'
  const profileId = profile.id // capturado p/ o recheck (M1)

  // Config por conexão: só o kill-switch + allowlist (compartilhados entre os
  // perfis daquela conexão). O "cérebro" agora mora no perfil.
  const { data: cfgRow } = await db
    .from('ai_agent_config')
    .select('enabled, allowed_phones')
    .eq('account_id', row.account_id)
    .eq('connection_id', row.connection_id)
    .maybeSingle()
  const cfg = cfgRow as Pick<AiAgentConfig, 'enabled' | 'allowed_phones'> | null
  if (!cfg?.enabled) return 'skipped:disabled'

  // Histórico recente (chat) + se é aluno (student_info) → sinal de roteamento.
  const messages = await serializeRecentMessages(db, row.conversation_id)
  if (messages.length === 0) return 'skipped:no_history' // nada a responder

  // Refresca o "digitando..." agora que o engine assumiu (cobre o tempo do LLM).
  if (row.last_inbound_message_id) {
    void engineSendTyping({
      accountId: row.account_id,
      conversationId: row.conversation_id,
      inboundWamid: row.last_inbound_message_id,
    })
  }
  const { data: student } = await db
    .from('student_info')
    .select('status, payload')
    .eq('account_id', row.account_id)
    .eq('contact_id', row.contact_id)
    .maybeSingle()

  // Dados do contato p/ personalização (nome/email) + phone p/ a allowlist.
  // Carregado uma vez aqui e reaproveitado no envio (evita 2ª consulta).
  const { data: contactRow } = await db
    .from('contacts')
    .select('name, email, phone')
    .eq('id', row.contact_id)
    .eq('account_id', row.account_id)
    .maybeSingle()
  const contact = contactRow as { name: string | null; email: string | null; phone: string | null } | null
  const studentCourses = extractStudentCourses(student)

  // Catálogo p/ o prompt (cursos ativos + categorias de suporte).
  const courses = await listCursos(db, row.account_id)
  const supportCategories = await listSupportCategories(db, row.account_id)

  // System prompt: persona DO PERFIL + voz-milla concatenada DEPOIS (precedência).
  const system = buildSystemPrompt({
    persona: profile.persona_prompt,
    courses,
    supportCategories,
    student: (student as { status: string | null; payload: unknown } | null) ?? null,
    contactName: contact?.name ?? null,
    contactEmail: contact?.email ?? null,
    studentCourses,
    opening: row.opening ?? false, // abertura: injeta a diretriz de cumprimento
  })

  // Loop LLM com tool-calling. O LLM roteia o assunto via a tool que escolhe.
  // `result` fica acessível no catch p/ a telemetria; null antes de rodar.
  const runStartedAt = Date.now()
  let result: {
    reply: string | null
    topic: 'vendas' | 'suporte' | null
    handoff: { to: string | null } | null
    telemetry: AgentTelemetry
  } | null = null

  // Monta a linha-base da run (ids + telemetria + latência) p/ ai_agent_runs.
  // `status` e os extras variam por caminho terminal; o resto vem do contexto
  // e da telemetria do loop. Usado nos 3 pontos de gravação (auth/superseded/fim).
  const buildRun = (
    status: AiAgentRun['status'],
    extra: {
      error_phase?: AiAgentRun['error_phase']
      guardrail_hits?: number
      topic?: AiAgentRun['topic']
      handoff?: boolean
    } = {},
  ): AgentRunInsert => ({
    account_id: row.account_id,
    connection_id: row.connection_id,
    conversation_id: row.conversation_id,
    contact_id: row.contact_id,
    profile_id: profileId,
    inbound_message_id: row.last_inbound_message_id ?? null,
    model: profile.model,
    status,
    error_phase: extra.error_phase ?? null,
    error_message: result?.telemetry.error?.message ?? null,
    finish_reason: result?.telemetry.finishReason ?? null,
    requests: result?.telemetry.requests ?? 0,
    turns: result?.telemetry.turns ?? 0,
    prompt_tokens: result?.telemetry.promptTokens ?? null,
    completion_tokens: result?.telemetry.completionTokens ?? null,
    total_tokens: result?.telemetry.totalTokens ?? null,
    cost_usd: result?.telemetry.costUsd ?? null,
    latency_ms: Date.now() - runStartedAt,
    llm_ms: result?.telemetry.llmMs ?? null,
    tools_used: result?.telemetry.toolsUsed ?? null,
    topic: extra.topic ?? null,
    handoff: extra.handoff ?? false,
    guardrail_hits: extra.guardrail_hits ?? 0,
  })

  try {
    result = await runAgentLoop({
      db,
      accountId: row.account_id,
      connectionId: row.connection_id,
      conversationId: row.conversation_id,
      contactId: row.contact_id,
      model: profile.model,
      classifierModel: profile.classifier_model,
      maxTurns: profile.max_bot_turns,
      system,
      messages,
      handoffRouting: profile.handoff_routing,
      allowedTools: profile.allowed_tools,
      opening: row.opening ?? false, // abertura: sem a tool transferir_humano
    })
  } catch (err) {
    // Falha antes/durante o loop sem telemetria (ex.: chave OpenRouter ausente).
    console.error('[ai_agent] loop failed:', err instanceof Error ? err.message : err)
    await recordAgentRun(db, buildRun('error', { error_phase: 'auth' }))
    return 'error'
  }

  // RECHECK (M1): a conversa ainda é do MESMO perfil que iniciou o run? Se um
  // humano/automação reatribuiu (a si ou a OUTRO perfil) enquanto o LLM pensava,
  // o bot para — não envia com a persona errada nem aplica handoff. Grava a run
  // como 'superseded' antes de sair (R1).
  const still = await resolveAssignedProfile(db, row.account_id, row.conversation_id)
  if (still?.id !== profileId) {
    await recordAgentRun(db, buildRun('superseded'))
    return 'superseded'
  }

  // ABERTURA: na 1ª resposta a IA não transfere (mesmo que o loop tenha pedido).
  // Zera ANTES do gate de handoff (:247) e da telemetria (handoff:!!result.handoff)
  // → não reatribui e grava handoff:false. A conversa segue com a IA; a resposta
  // SEGUINTE (cron, sem opening) pode encaminhar normalmente.
  if (row.opening) result.handoff = null
  // Observabilidade do risco aceito: abertura sem texto (modelo só quis transferir).
  if (row.opening && !result.reply?.trim()) {
    console.warn('[ai_agent] abertura sem texto (só handoff suprimido):', row.conversation_id)
  }

  // Grava o assunto detectado (analytics + roteamento de handoff).
  if (result.topic) {
    await db.from('conversations').update({ ai_topic: result.topic }).eq('id', row.conversation_id)
  }

  // Conta escapada de marca ANTES do gate da allowlist (R2): mede aderência à
  // voz mesmo quando o envio é bloqueado.
  const guardrailHits = result.reply ? (hasForbidden(result.reply) ? 1 : 0) : 0

  // Desfecho do envio p/ a telemetria.
  let status: 'ok' | 'no_reply' | 'blocked' | 'error' = 'no_reply'
  let errorPhase: AiAgentRun['error_phase'] = null

  // Envia a resposta (se houver texto). transferir_humano/encerrar podem
  // não ter texto — nesse caso só aplica o handoff abaixo.
  if (result.reply?.trim()) {
    // Allowlist opcional (defesa dupla): reusa o contato já carregado acima.
    if (phoneAllowed(contact?.phone, cfg.allowed_phones)) {
      // Pós-filtro de marca (obrigatório) antes do envio.
      const safe = applyGuardrail(result.reply)
      // userId p/ auditoria do engineSendText (não é consultado p/ tenancy —
      // meta-send.ts:32). Usa o dono da conexão; cai pro account_id se faltar.
      const { data: conn } = await db
        .from('whatsapp_config')
        .select('user_id')
        .eq('id', row.connection_id)
        .eq('account_id', row.account_id)
        .maybeSingle()
      const userId = (conn as { user_id: string } | null)?.user_id ?? row.account_id
      // Quebra a resposta em BOLHAS (parágrafos) e envia uma a uma, como um
      // humano digita no WhatsApp. Entre bolhas: "digitando" + pausa curta.
      const parts = splitIntoMessages(safe)
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          if (row.last_inbound_message_id) {
            void engineSendTyping({
              accountId: row.account_id,
              conversationId: row.conversation_id,
              inboundWamid: row.last_inbound_message_id,
            })
          }
          await new Promise((r) => setTimeout(r, 900))
        }
        try {
          await engineSendText({
            accountId: row.account_id,
            userId,
            conversationId: row.conversation_id,
            contactId: row.contact_id,
            text: parts[i],
          })
        } catch (err) {
          console.error('[ai_agent] send failed:', err instanceof Error ? err.message : err)
          errorPhase = 'send'
        }
      }
      status = errorPhase ? 'error' : 'ok'
    } else {
      console.warn('[ai_agent] contato fora da allowlist — envio bloqueado:', row.conversation_id)
      status = 'blocked'
    }
  }
  // Erro do loop LLM (HTTP/fetch) tem precedência sobre no_reply.
  if (result.telemetry.error) {
    status = 'error'
    errorPhase = 'llm'
  }

  // HANDOFF pós-envio: a IA pediu transferência → reatribui a conversa ao
  // humano roteado (ou desatribui, se sem rota). Feito DEPOIS do envio para
  // a mensagem de "vou te transferir" sair antes de o bot deixar de ser o
  // responsável. A partir daqui, resolveAssignedProfile() falha → bot para.
  if (result.handoff) {
    await db
      .from('conversations')
      .update({ assigned_agent_id: result.handoff.to })
      .eq('id', row.conversation_id)
      .eq('account_id', row.account_id)
  }

  // Ponto único de gravação (R4): cobre ok/no_reply/blocked/error(send|llm).
  await recordAgentRun(
    db,
    buildRun(status, {
      error_phase: errorPhase,
      guardrail_hits: guardrailHits,
      topic: result.topic,
      handoff: !!result.handoff,
    }),
  )
  // Desfecho real (ok/no_reply/blocked/error) p/ o chamador logar.
  return status
}

// Divide a resposta do bot em mensagens separadas (bolhas do WhatsApp), quebrando
// por parágrafo (linha em branco) — fica natural, como gente digitando. Junta o
// excedente além de MAX_BOLHAS na última, p/ nunca spammar dezenas de mensagens.
const MAX_BOLHAS = 6
export function splitIntoMessages(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts.length === 0) return [text.trim()].filter(Boolean)
  if (parts.length <= MAX_BOLHAS) return parts
  const head = parts.slice(0, MAX_BOLHAS - 1)
  const tail = parts.slice(MAX_BOLHAS - 1).join('\n\n')
  return [...head, tail]
}

// Extrai os nomes dos cursos/módulos matriculados do payload do student_info.
// Forma: payload.cursos_matriculados[] = { nome_curso, ... }. [] se não for aluno.
export function extractStudentCourses(student: unknown): string[] {
  const payload = (student as { payload?: { cursos_matriculados?: unknown } } | null)?.payload
  const arr = payload?.cursos_matriculados
  if (!Array.isArray(arr)) return []
  return arr
    .map((c) => (c as { nome_curso?: string })?.nome_curso)
    .filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
}
