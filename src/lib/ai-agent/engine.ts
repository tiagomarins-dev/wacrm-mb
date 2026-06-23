// ============================================================
// Engine do agente — roda o ciclo p/ UMA conversa madura (drenada do
// debounce pelo cron). Junta contexto, roda o loop LLM com tools de
// roteamento, aplica o pós-filtro (guardrail) e envia via engineSendText
// (R1 — reusa o sender canônico: resolve conexão + decrypt + persiste
// sender_type='bot' + retry phone-variant).
// Espelha a estrutura de executeAutomation (automations/engine.ts:175).
// ============================================================
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText, engineSendTyping } from '@/lib/automations/meta-send'
import { resolveAssignedProfile, phoneAllowed } from './dispatch'
import { buildSystemPrompt, serializeRecentMessages } from './prompt'
import { listCursos, listSupportCategories } from './knowledge'
import { runAgentLoop } from './llm'
import { applyGuardrail } from './guardrail'
import type { AiAgentConfig } from '@/types'

// Subconjunto da row de ai_agent_pending que o engine precisa.
export interface PendingRow {
  id: string
  account_id: string
  connection_id: string
  conversation_id: string
  contact_id: string
  last_inbound_message_id?: string | null // wamid p/ o "digitando..."
}

// Executa o agente p/ uma conversa: monta contexto, roda o loop, aplica
// guardrail, recheca controle humano e envia a resposta.
export async function runAiAgentForConversation(row: PendingRow): Promise<void> {
  const db = supabaseAdmin()

  // Perfil de IA responsável pela conversa — persona/modelo/tools/handoff vêm
  // DELE. null = não há perfil ativo atribuído (humano/órfão) → não atua.
  const profile = await resolveAssignedProfile(db, row.account_id, row.conversation_id)
  if (!profile) return
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
  if (!cfg?.enabled) return

  // Histórico recente (chat) + se é aluno (student_info) → sinal de roteamento.
  const messages = await serializeRecentMessages(db, row.conversation_id)
  if (messages.length === 0) return // nada a responder

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
  })

  // Loop LLM com tool-calling. O LLM roteia o assunto via a tool que escolhe.
  let result: {
    reply: string | null
    topic: 'vendas' | 'suporte' | null
    handoff: { to: string | null } | null
  }
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
    })
  } catch (err) {
    console.error('[ai_agent] loop failed:', err instanceof Error ? err.message : err)
    return
  }

  // RECHECK (M1): a conversa ainda é do MESMO perfil que iniciou o run? Se um
  // humano/automação reatribuiu (a si ou a OUTRO perfil) enquanto o LLM pensava,
  // o bot para — não envia com a persona errada nem aplica handoff.
  const still = await resolveAssignedProfile(db, row.account_id, row.conversation_id)
  if (still?.id !== profileId) return

  // Grava o assunto detectado (analytics + roteamento de handoff).
  if (result.topic) {
    await db.from('conversations').update({ ai_topic: result.topic }).eq('id', row.conversation_id)
  }

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
        }
      }
    } else {
      console.warn('[ai_agent] contato fora da allowlist — envio bloqueado:', row.conversation_id)
    }
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
