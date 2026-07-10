import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { resolveTokens } from '@/lib/link-tracking/resolve'

export const runtime = 'nodejs'

// POST { tokens: string[] } → { map: { <token>: <urlOriginal> } }. Account-scoped: só
// resolve tokens da conta do chamador. Auth 401/403 (espelha send/route.ts:27-63), rate
// limit dedicado, cap 200 e filtro de formato hex. Delega a leitura p/ resolveTokens.
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const rl = checkRateLimit(`linkResolve:${user.id}`, RATE_LIMITS.linkResolve)
  if (!rl.success) return rateLimitResponse(rl)

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

  const body = await request.json().catch(() => ({}))
  const raw = body?.tokens
  if (!Array.isArray(raw) || raw.length > 200) {
    return NextResponse.json(
      { error: 'tokens must be an array of at most 200' },
      { status: 400 },
    )
  }
  // Filtra p/ o formato exato do token (32 hex) — descarta lixo antes do IN.
  const tokens = raw.filter(
    (t): t is string => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t),
  )

  const map = await resolveTokens(supabaseAdmin(), accountId, tokens)
  return NextResponse.json({ map })
}
