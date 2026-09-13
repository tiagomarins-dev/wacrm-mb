import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runMbClassSync } from '@/lib/mb-sync/sync'

// Runtime Node: timingSafeEqual + service-role exigem Node.
export const runtime = 'nodejs'
// Uma chamada à Plataforma MB por curso + dezenas de requisições ao Supabase em
// turmas grandes; o curl do sidecar usa -m 130.
export const maxDuration = 120

/**
 * Sincronização horária das turmas MB → tags. Só autentica (mesmo
 * AUTOMATION_CRON_SECRET dos demais crons) e chama runMbClassSync; ?dry=1
 * calcula sem gravar. Resposta só com contagens.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (suppliedBuf.length !== expectedBuf.length || !timingSafeEqual(suppliedBuf, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const dryParam = new URL(request.url).searchParams.get('dry')
  const dry = dryParam === '1' || dryParam === 'true'

  try {
    return NextResponse.json(await runMbClassSync({ dry }))
  } catch (err) {
    // falhas da API da plataforma ficam registradas por tag em mb_class_sync_runs;
    // aqui chega só erro de banco — a mensagem vai pro log, nunca pra resposta
    console.error('[mb-sync/cron] failed:', (err as Error).message)
    return NextResponse.json({ error: 'mb sync failed' }, { status: 500 })
  }
}
