import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveOutboundConfig } from '@/lib/connections/resolve'
import { findOrCreateConversation } from '@/lib/whatsapp/inbound'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  resolveSupportConfig,
  SupportConnectionError,
} from '@/lib/connections/support'
import {
  normalizeDeepLinkPhone,
  sanitizeContactName,
  findOrCreateContactByPhone,
} from '@/lib/conversations/open-by-phone'

/**
 * Abre (ou reusa) a conversa de um contato e devolve o id p/ deep-link no inbox.
 *
 * Dois contratos na mesma rota:
 *  - `{ contact_id }` — a tela de Contatos, que já tem o contato em mãos.
 *  - `{ phone }`      — o link externo da Plataforma MB, que só conhece o número
 *                       e sempre abre na conexão de Suporte.
 *
 * `contact_id` vence quando os dois vêm: é o chamador antigo e não pode mudar de
 * comportamento. Cria só quando o atendente inicia do zero — mesmo helper
 * idempotente do inbound.
 */
export async function POST(request: Request) {
  // Body antes de tudo: é ele que decide o branch, e cada branch tem seu bucket
  // de rate limit. Sem o catch, um corpo não-JSON viraria 500 não tratado.
  const body = await request.json().catch(() => ({}))
  const contactId = body?.contact_id as string | undefined
  const rawPhone = body?.phone

  if (!contactId && rawPhone !== undefined) {
    return openByPhone(body, rawPhone)
  }

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

/**
 * Branch do deep-link externo: telefone -> contato -> conversa, sempre na
 * conexão de Suporte.
 *
 * O guard de papel fica AQUI e não no topo da rota de propósito. Mover pra cima
 * mudaria o contrato do caminho por `contact_id`, onde um viewer hoje consegue
 * abrir uma conversa que já existe (é só leitura, sem INSERT). Este branch
 * escreve, então exige agent+ — o mesmo que as policies contacts_insert e
 * conversations_insert já exigem, só que checado antes, com erro legível.
 */
async function openByPhone(
  body: Record<string, unknown>,
  rawPhone: unknown,
): Promise<NextResponse> {
  try {
    const ctx = await requireRole('agent')

    // Bucket próprio: navegação não pode consumir a cota de envio do atendente.
    const limit = checkRateLimit(
      `open-phone:${ctx.userId}`,
      RATE_LIMITS.openByPhone,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const phone = normalizeDeepLinkPhone(rawPhone)
    if (!phone) {
      return NextResponse.json(
        { error: 'Invalid phone number', code: 'invalid_phone' },
        { status: 422 },
      )
    }
    const name = sanitizeContactName(body?.nome ?? body?.name, phone)

    // connection_id do body é IGNORADO neste branch: o link externo sempre abre
    // no Suporte, e quem chama de fora não pode escolher outro número.
    let config
    try {
      config = await resolveSupportConfig(ctx.supabase, ctx.accountId)
    } catch (err) {
      // Loga o motivo (env ausente / id de outra conta / arquivada) sem devolver
      // o UUID da conexão na resposta.
      console.error(
        '[open] conexão de Suporte indisponível:',
        err instanceof SupportConnectionError ? err.reason : err,
      )
      return NextResponse.json(
        {
          error: 'Support connection unavailable',
          code: 'support_connection_unavailable',
        },
        { status: 409 },
      )
    }

    const outcome = await findOrCreateContactByPhone(
      ctx.supabase,
      ctx.accountId,
      config.user_id,
      config.id,
      phone,
      name,
    )
    if (!outcome) {
      return NextResponse.json(
        { error: 'Failed to open contact', code: 'contact_create_failed' },
        { status: 500 },
      )
    }

    // Reusa a conversa mesmo finalizada, sem tocar no status: quem chegou pelo
    // link quer falar com o aluno agora, não reabrir um atendimento antigo.
    const conversation = await findOrCreateConversation(
      ctx.supabase,
      ctx.accountId,
      config.user_id,
      config.id,
      outcome.contact.id,
    )
    if (!conversation) {
      return NextResponse.json(
        { error: 'Failed to open conversation' },
        { status: 500 },
      )
    }

    return NextResponse.json({
      conversation_id: conversation.id,
      contact_id: outcome.contact.id,
      created_contact: outcome.wasCreated,
    })
  } catch (err) {
    // 401 e 403 tipados de lib/auth/account.
    return toErrorResponse(err)
  }
}
