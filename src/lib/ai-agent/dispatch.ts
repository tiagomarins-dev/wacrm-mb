// ============================================================
// Dispatch do agente IA — chamado pelo webhook (fire-and-forget) após
// flows/automations. NÃO responde inline (webhook precisa de 200 OK
// rápido): só decide se o agente deve responder e empurra o deadline de
// debounce na fila ai_agent_pending. O cron drena depois.
// Espelha dispatchInboundToFlows (src/lib/flows/engine.ts:918): service-role,
// try/catch interno, nunca lança.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendTyping } from '@/lib/automations/meta-send'
import type { AiProfile } from '@/types'

// MODO TESTE (allowlist): se `allowed` está preenchida, o agente SÓ atende
// contatos cujo telefone (só dígitos) casa com a lista — por igualdade ou
// por sufixo (tolera o prefixo de país 55). Lista vazia/null = responde a
// todos. Usado como trava de segurança no dispatch E no engine (defesa dupla).
export function phoneAllowed(
  contactPhone: string | null | undefined,
  allowed: string[] | null | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true
  const cd = (contactPhone ?? '').replace(/\D/g, '')
  if (!cd) return false
  return allowed.some((a) => {
    const ad = (a ?? '').replace(/\D/g, '')
    return ad.length > 0 && (cd === ad || cd.endsWith(ad))
  })
}

export interface DispatchAiInput {
  accountId: string
  connectionId: string
  contactId: string
  conversationId: string
  inboundMessageId: string // message.id da Meta (last_inbound_message_id)
  flowConsumed: boolean // P4: Flow > Agente é a única precedência detectável
}

// Decide se o agente deve responder e, em caso afirmativo, faz upsert na
// fila empurrando run_at (debounce). Nunca lança (fire-and-forget).
export async function dispatchInboundToAiAgent(input: DispatchAiInput): Promise<void> {
  try {
    const db = supabaseAdmin()

    // Precedência: se um Flow consumiu a mensagem, o cliente está navegando
    // o bot de flow — o agente não entra (evita dois bots falando junto).
    // "Automation > Agente" NÃO é detectável aqui (automations são
    // fire-and-forget, sem retorno) — limitação documentada (P4).
    if (input.flowConsumed) return

    // Agente ligado nesta conexão?
    const { data: cfg } = await db
      .from('ai_agent_config')
      .select('enabled, debounce_seconds, allowed_phones')
      .eq('account_id', input.accountId)
      .eq('connection_id', input.connectionId)
      .maybeSingle()
    if (!cfg?.enabled) return

    // CONTROLE PRINCIPAL: a IA só atua se a conversa estiver atribuída a um
    // PERFIL de IA ativo. Humano "assume" reatribuindo a si → bot para.
    if (!(await resolveAssignedProfile(db, input.accountId, input.conversationId))) return

    // Contato pediu pra não falar com bot? (e pega o phone p/ a allowlist)
    const { data: contact } = await db
      .from('contacts')
      .select('ai_opt_out, phone')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle()
    if (!contact || contact.ai_opt_out) return

    // Allowlist opcional (trava extra de teste). Vazia = sem restrição.
    if (!phoneAllowed(contact.phone, cfg.allowed_phones)) return

    // Upsert na fila: empurra run_at a cada nova msg (debounce real). O
    // UNIQUE(conversation_id) garante 1 pendência por conversa.
    const runAt = new Date(Date.now() + (cfg.debounce_seconds ?? 12) * 1000).toISOString()
    const { error } = await db.from('ai_agent_pending').upsert(
      {
        account_id: input.accountId,
        connection_id: input.connectionId,
        conversation_id: input.conversationId,
        contact_id: input.contactId,
        run_at: runAt,
        status: 'pending',
        last_inbound_message_id: input.inboundMessageId,
      },
      { onConflict: 'conversation_id' },
    )
    if (error) console.error('[ai_agent] enqueue failed:', error.message)

    // "digitando..." imediato (feedback enquanto o debounce + cron + LLM rolam).
    // Fire-and-forget; dura ~25s e é refrescado pelo engine quando ele assume.
    void engineSendTyping({
      accountId: input.accountId,
      conversationId: input.conversationId,
      inboundWamid: input.inboundMessageId,
    })
  } catch (err) {
    console.error('[ai_agent] dispatch failed:', err instanceof Error ? err.message : err)
  }
}

// Resolve o PERFIL de IA responsável pela conversa: lê assigned_agent_id e
// carrega o ai_profile correspondente (account-scoped + enabled). null = não
// há perfil de IA ativo (humano / órfão / desabilitado) → o bot não atua.
// É o gate central: usado no dispatch (enfileirar) e no engine (rechecar antes
// de enviar — se reatribuíram pra outro perfil/humano no meio, o bot para).
// Service-role bypassa RLS → filtra account_id explícito (igual knowledge.ts:6-8).
export async function resolveAssignedProfile(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<AiProfile | null> {
  const { data: conv } = await db
    .from('conversations')
    .select('assigned_agent_id')
    .eq('id', conversationId)
    .maybeSingle()
  const assigned = (conv as { assigned_agent_id: string | null } | null)?.assigned_agent_id
  if (!assigned) return null
  const { data: profile } = await db
    .from('ai_profiles')
    .select('*')
    .eq('id', assigned)
    .eq('account_id', accountId)
    .eq('enabled', true)
    .maybeSingle()
  return (profile as AiProfile | null) ?? null
}
