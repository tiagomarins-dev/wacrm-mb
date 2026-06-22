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

    // Contato pediu pra não falar com bot? (e pega o phone p/ a allowlist)
    const { data: contact } = await db
      .from('contacts')
      .select('ai_opt_out, phone')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle()
    if (!contact || contact.ai_opt_out) return

    // MODO TESTE: fora da allowlist → não enfileira (trava de segurança).
    if (!phoneAllowed(contact.phone, cfg.allowed_phones)) return

    // Humano no controle? (atendente respondeu por último nesta conversa.)
    if (await humanRecentlyReplied(db, input.conversationId)) return

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
  } catch (err) {
    console.error('[ai_agent] dispatch failed:', err instanceof Error ? err.message : err)
  }
}

// Janela (min) em que um atendente humano é considerado "no controle" após
// responder. Passada a janela, o bot pode reengajar um NOVO inbound — senão
// qualquer conversa que um humano tocou uma vez ficaria morta pro bot pra
// sempre. (Sem coluna nova — decisão de escopo da reauditoria.)
export const HUMAN_CONTROL_WINDOW_MIN = 30

// True se um atendente humano respondeu RECENTEMENTE (dentro da janela) e
// é a última msg agent/bot — ou seja, está conduzindo a conversa agora.
// Usado no gate do dispatch e no recheck do engine.
export async function humanRecentlyReplied(
  db: SupabaseClient,
  conversationId: string,
  withinMinutes: number = HUMAN_CONTROL_WINDOW_MIN,
): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('sender_type, created_at')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const row = data as { sender_type: string; created_at: string } | null
  if (row?.sender_type !== 'agent') return false
  // Só "no controle" se a resposta humana foi recente.
  const ageMs = Date.now() - new Date(row.created_at).getTime()
  return Number.isFinite(ageMs) && ageMs <= withinMinutes * 60_000
}
