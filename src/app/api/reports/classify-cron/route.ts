import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runIntentCron } from '@/lib/reports/intent-cron'

// Runtime Node: timingSafeEqual + service-role + LLM exigem Node.
export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * Worker de classificação de intenção (Fase 3). Só autentica (timing-safe, mesmo
 * AUTOMATION_CRON_SECRET) e chama runIntentCron(); toda a regra mora em
 * src/lib/reports/intent-cron.ts. No-op temporal (20h) honra a cadência diária.
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
    const result = await runIntentCron()
    return NextResponse.json(result)
  } catch (err) {
    console.error('[reports/classify-cron] failed:', (err as Error).message)
    return NextResponse.json({ error: 'classify cron failed' }, { status: 500 })
  }
}
