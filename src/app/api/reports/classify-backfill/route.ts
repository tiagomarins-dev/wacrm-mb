import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runIntentCron } from '@/lib/reports/intent-cron'

// Runtime Node: timingSafeEqual + service-role + LLM exigem Node.
export const runtime = 'nodejs'
export const maxDuration = 60

// Clampa um inteiro do body (defensivo — LLM é caro; janela absurda viraria full-scan).
function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def
  return Math.max(min, Math.min(max, n))
}

/**
 * Backfill retroativo da classificação completa (F2/068). Igual ao classify-cron,
 * mas PULA o no-op de 20h e aceita janela/cap no body. Operação: chamar repetidas
 * vezes (curl -m 400) até classified=0. Mesmo secret dos demais crons.
 */
export async function POST(request: Request) {
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

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const windowDays = clampInt(body.window_days, 365, 1, 730)
  const cap = clampInt(body.cap, 100, 1, 300)

  try {
    const result = await runIntentCron({ backfill: true, windowDays, cap })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[reports/classify-backfill] failed:', (err as Error).message)
    return NextResponse.json({ error: 'backfill failed' }, { status: 500 })
  }
}
