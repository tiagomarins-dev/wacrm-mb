import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getClientIp,
  requirePlaygroundAuth,
  resolvePlaygroundAccountId,
} from '@/lib/playground-ruth/auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

export const runtime = 'nodejs'

// Localiza contatos por SUFIXO do telefone e diz se cada um tem lead_context
// (respostas da pesquisa de broadcast). Privacidade: o telefone nunca volta
// inteiro (só últimos 4) e os VALORES do lead_context nunca saem da API —
// eles só entram no prompt, server-side, no /chat.
export async function POST(request: Request) {
  const denied = requirePlaygroundAuth(request)
  if (denied) return denied
  const limit = checkRateLimit(`pg-lookup:${getClientIp(request)}`, RATE_LIMITS.playgroundLookup)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => ({}))) as { phoneSuffix?: unknown }
  // Só dígitos: além de validar, mata qualquer curinga (%/_) no LIKE.
  const suffix = String(body.phoneSuffix ?? '').replace(/\D/g, '')
  if (suffix.length < 4 || suffix.length > 15) {
    return NextResponse.json({ error: 'sufixo deve ter de 4 a 15 dígitos' }, { status: 422 })
  }

  const db = supabaseAdmin()
  const anchor = await resolvePlaygroundAccountId(db)
  if ('response' in anchor) return anchor.response

  const { data: contacts } = await db
    .from('contacts')
    .select('id, name, phone')
    .eq('account_id', anchor.accountId)
    .like('phone', `%${suffix}`)
    .limit(5)

  // Último lead_context não-nulo de cada match (espelha engine.ts — join com
  // broadcasts pro filtro explícito de conta, a tabela não tem account_id).
  const matches = []
  for (const c of (contacts as { id: string; name: string | null; phone: string | null }[] | null) ??
    []) {
    const { data: recs } = await db
      .from('broadcast_recipients')
      .select('lead_context, broadcasts!inner(account_id)')
      .eq('contact_id', c.id)
      .eq('broadcasts.account_id', anchor.accountId)
      .not('lead_context', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
    const lc =
      (recs?.[0] as { lead_context: Record<string, string> | null } | undefined)?.lead_context ??
      null
    matches.push({
      contactId: c.id,
      name: c.name,
      phoneLast4: (c.phone ?? '').slice(-4),
      hasLeadContext: lc !== null,
      leadContextKeys: lc ? Object.keys(lc) : [],
    })
  }
  return NextResponse.json({ matches })
}
