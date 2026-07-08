import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveOutboundConfig } from '@/lib/connections/resolve'
import { findOrCreateConversation } from '@/lib/whatsapp/inbound'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// Abre (ou reusa) a conversa de um contato e devolve o id p/ deep-link no inbox.
// Cria só quando o atendente inicia do zero — mesmo helper idempotente do inbound.
// Client RLS (não admin): o insert passa pela policy conversations_insert (agent+).
export async function POST(request: Request) {
  const supabase = await createClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate-limit por usuário (espelha o bucket do send) — evita criar conversas em massa.
  const limit = checkRateLimit(`open:${user.id}`, RATE_LIMITS.send)
  if (!limit.success) return rateLimitResponse(limit)

  // Conta do chamador — toda leitura/escrita é escopada a ela (pós multi-user).
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const body = await request.json()
  const contactId = body?.contact_id as string | undefined
  const connectionId = (body?.connection_id as string | null | undefined) ?? null
  if (!contactId) {
    return NextResponse.json({ error: 'contact_id required' }, { status: 400 })
  }

  // Contato tem que ser DA conta (RLS + checagem explícita → 404). Traz phone p/
  // o guard: contato só-email geraria conversa que o composer não consegue enviar.
  const { data: contact } = await supabase
    .from('contacts')
    .select('id, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!contact) {
    return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  }
  if (!contact.phone) {
    return NextResponse.json({ error: 'Contact has no phone number' }, { status: 400 })
  }

  // Conexão: a ATIVA (body) validada/escopada à conta; fallback pra primária no
  // server. throw se a conta não tem nenhuma conexão de envio.
  let config
  try {
    config = await resolveOutboundConfig(supabase, accountId, connectionId)
  } catch {
    return NextResponse.json(
      { error: 'No WhatsApp connection available' },
      { status: 400 },
    )
  }

  // Acha/cria (idempotente, índice UNIQUE 041). owner = dono da config (espelha o
  // inbound, que usa o configOwnerUserId).
  const conversation = await findOrCreateConversation(
    supabase,
    accountId,
    config.user_id,
    config.id,
    contactId,
  )
  if (!conversation) {
    return NextResponse.json(
      { error: 'Failed to open conversation' },
      { status: 500 },
    )
  }

  return NextResponse.json({ conversation_id: conversation.id })
}
