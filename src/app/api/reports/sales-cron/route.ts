import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runSalesCron } from '@/lib/reports/sales-cron'

// Runtime Node: timingSafeEqual + service-role + chamada externa exigem Node.
export const runtime = 'nodejs'
// A varredura pode demorar (lotes p/ a MB) — estende o limite da função.
export const maxDuration = 60

/**
 * Worker de atribuição de venda (Fase 2). Só autentica (timing-safe, mesmo
 * AUTOMATION_CRON_SECRET dos demais crons) e chama runSalesCron(); toda a regra
 * mora em src/lib/reports/sales-cron.ts (+ sales-attribution.ts puro). O no-op
 * temporal (20h) dentro da lib honra a cadência diária mesmo se chamado a cada 60s.
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

  try {
    const result = await runSalesCron()
    return NextResponse.json(result)
  } catch (err) {
    // não vaza key/PII — só a mensagem curta
    console.error('[reports/sales-cron] failed:', (err as Error).message)
    return NextResponse.json({ error: 'sales cron failed' }, { status: 500 })
  }
}
