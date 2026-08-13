import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// IP best-effort atrás de proxy: x-forwarded-for (primeiro hop) → x-real-ip →
// constante em dev (o limite vira global, aceitável fora de produção).
export function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

// Gate de senha do playground: rate-limit por IP ANTES do compare (fecha o
// oráculo de brute force mesmo com bucket estourado) + comparação constant-time
// com pré-check de length (exigência do timingSafeEqual; só vaza o tamanho).
// null = autorizado; NextResponse = 503/429/401 pronto pra devolver.
// A senha recebida NUNCA é logada.
export function requirePlaygroundAuth(request: Request): NextResponse | null {
  const expected = process.env.PLAYGROUND_RUTH_PASSWORD
  if (!expected) {
    return NextResponse.json({ error: 'playground not configured' }, { status: 503 })
  }
  const limit = checkRateLimit(`pg-auth:${getClientIp(request)}`, RATE_LIMITS.playgroundAuth)
  if (!limit.success) return rateLimitResponse(limit)
  const supplied = request.headers.get('x-playground-password') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}

// Conta-âncora do playground: única fonte de account_id de TODAS as queries
// service-role das rotas (o service-role bypassa RLS, então o filtro explícito
// é o que impede vazar dado de outra conta). Env explícita > detecção
// (exatamente 1 conta em ai_profiles). Multi-conta sem env falha fechado (409).
export async function resolvePlaygroundAccountId(
  db: SupabaseClient,
): Promise<{ accountId: string } | { response: NextResponse }> {
  const envAnchor = process.env.PLAYGROUND_RUTH_ACCOUNT_ID
  if (envAnchor) return { accountId: envAnchor }
  const { data } = await db.from('ai_profiles').select('account_id')
  const accounts = [
    ...new Set((((data as { account_id: string }[] | null) ?? []).map((r) => r.account_id))),
  ]
  if (accounts.length === 1) return { accountId: accounts[0] }
  if (accounts.length === 0) {
    return {
      response: NextResponse.json({ error: 'nenhum perfil de IA cadastrado' }, { status: 404 }),
    }
  }
  return {
    response: NextResponse.json(
      { error: 'múltiplas contas com perfis de IA — defina PLAYGROUND_RUTH_ACCOUNT_ID' },
      { status: 409 },
    ),
  }
}
