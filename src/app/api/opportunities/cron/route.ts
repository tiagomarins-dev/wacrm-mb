import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runOpportunityTagSync } from '@/lib/opportunities/tag-sync'

// Runtime Node: timingSafeEqual + service-role exigem Node.
export const runtime = 'nodejs'
// Várias RPCs por conta em listas grandes; o curl do sidecar usa -m 130.
export const maxDuration = 120

/**
 * Mantém a tag 'oportunidade' (tela Oportunidades). Só autentica com o mesmo
 * AUTOMATION_CRON_SECRET dos demais crons e delega; ?dry=1 conta sem gravar.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  if (supplied.length !== expectedBuf.length || !timingSafeEqual(supplied, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const dryParam = new URL(request.url).searchParams.get('dry')
  const dry = dryParam === '1' || dryParam === 'true'
  try {
    return NextResponse.json(await runOpportunityTagSync({ dry }))
  } catch (err) {
    console.error('[opportunities/cron] failed:', (err as Error).message)
    return NextResponse.json({ error: 'opportunities sync failed' }, { status: 500 })
  }
}
