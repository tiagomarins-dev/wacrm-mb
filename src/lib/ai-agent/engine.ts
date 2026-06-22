// ============================================================
// Engine do agente — roda o ciclo p/ UMA conversa madura (drenada do
// debounce pelo cron). Junta contexto, roda o loop LLM com tools de
// roteamento, aplica o pós-filtro (guardrail) e envia via engineSendText
// (R1 — reusa o sender canônico: resolve conexão + decrypt + persiste
// sender_type='bot' + retry phone-variant).
// Espelha a estrutura de executeAutomation (automations/engine.ts:175).
// ============================================================
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText } from '@/lib/automations/meta-send'
import { isAssignedToAi, phoneAllowed } from './dispatch'
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
}

// Executa o agente p/ uma conversa: monta contexto, roda o loop, aplica
// guardrail, recheca controle humano e envia a resposta.
export async function runAiAgentForConversation(row: PendingRow): Promise<void> {
  const db = supabaseAdmin()

  // Config do agente (modelo, persona, handoff, max_turns).
  const { data: cfgRow } = await db
    .from('ai_agent_config')
    .select('*')
    .eq('account_id', row.account_id)
    .eq('connection_id', row.connection_id)
    .maybeSingle()
  const cfg = cfgRow as AiAgentConfig | null
  if (!cfg?.enabled) return

  // Histórico recente (chat) + se é aluno (student_info) → sinal de roteamento.
  const messages = await serializeRecentMessages(db, row.conversation_id)
  if (messages.length === 0) return // nada a responder
  const { data: student } = await db
    .from('student_info')
    .select('status, payload')
    .eq('account_id', row.account_id)
    .eq('contact_id', row.contact_id)
    .maybeSingle()

  // Catálogo p/ o prompt (cursos ativos + categorias de suporte).
  const courses = await listCursos(db, row.account_id)
  const supportCategories = await listSupportCategories(db, row.account_id)

  // System prompt: voz-milla é concatenada DEPOIS da persona (precedência).
  const system = buildSystemPrompt({
    persona: cfg.persona_prompt,
    courses,
    supportCategories,
    student: (student as { status: string | null; payload: unknown } | null) ?? null,
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
      model: cfg.model,
      classifierModel: cfg.classifier_model,
      maxTurns: cfg.max_bot_turns,
      system,
      messages,
      handoffRouting: cfg.handoff_routing,
    })
  } catch (err) {
    console.error('[ai_agent] loop failed:', err instanceof Error ? err.message : err)
    return
  }

  // RECHECK: a IA ainda é a responsável? Se um humano reatribuiu a conversa
  // enquanto o LLM pensava, o bot para — não envia nem aplica handoff.
  if (!(await isAssignedToAi(db, row.conversation_id))) return

  // Grava o assunto detectado (analytics + roteamento de handoff).
  if (result.topic) {
    await db.from('conversations').update({ ai_topic: result.topic }).eq('id', row.conversation_id)
  }

  // Envia a resposta (se houver texto). transferir_humano/encerrar podem
  // não ter texto — nesse caso só aplica o handoff abaixo.
  if (result.reply?.trim()) {
    // Allowlist opcional (defesa dupla): se setada, não envia fora da lista.
    const { data: contact } = await db
      .from('contacts')
      .select('phone')
      .eq('id', row.contact_id)
      .eq('account_id', row.account_id)
      .maybeSingle()
    if (phoneAllowed((contact as { phone: string | null } | null)?.phone, cfg.allowed_phones)) {
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
      try {
        await engineSendText({
          accountId: row.account_id,
          userId,
          conversationId: row.conversation_id,
          contactId: row.contact_id,
          text: safe,
        })
      } catch (err) {
        console.error('[ai_agent] send failed:', err instanceof Error ? err.message : err)
      }
    } else {
      console.warn('[ai_agent] contato fora da allowlist — envio bloqueado:', row.conversation_id)
    }
  }

  // HANDOFF pós-envio: a IA pediu transferência → reatribui a conversa ao
  // humano roteado (ou desatribui, se sem rota). Feito DEPOIS do envio para
  // a mensagem de "vou te transferir" sair antes de o bot deixar de ser o
  // responsável. A partir daqui, isAssignedToAi() falha → bot não atua mais.
  if (result.handoff) {
    await db
      .from('conversations')
      .update({ assigned_agent_id: result.handoff.to })
      .eq('id', row.conversation_id)
      .eq('account_id', row.account_id)
  }
}
