import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/broadcast/admin-client'
import { drainBroadcast, type ScheduledBroadcastRow } from '@/lib/broadcast/send-engine'

// Usa node:crypto (timingSafeEqual) + service-role; força runtime Node.
export const runtime = 'nodejs'

const SELECT_FIELDS =
  'id, account_id, template_name, template_language, template_variables'
const MAX_BROADCASTS_PER_TICK = 20
const PER_BROADCAST_LIMIT = 50 // recipients por broadcast por tick
const GLOBAL_RECIPIENT_CAP = 200 // teto total de envios por tick (anti-timeout / rate limit Meta)

/**
 * Cron de broadcast agendado. Batido por scheduler externo (sidecar) a cada
 * ~1 min com header `x-cron-secret` = AUTOMATION_CRON_SECRET (mesmo secret
 * dos crons de automations/flows). Por tick:
 *   1. claim das broadcasts 'scheduled' vencidas → 'sending' (lock por linha)
 *   2. drena recipients 'pending' das 'sending' (inclui as recém-claimed e
 *      as retomadas de ticks anteriores), respeitando um teto global
 * Idempotente: o engine só toca recipients 'pending'. O sidecar é sequencial
 * (curl aguarda a resposta), então não há ticks sobrepostos.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Compare constant-time (mesmo padrão de flows/cron) — length pré-check
  // exigido por timingSafeEqual e só vaza o tamanho.
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const nowIso = new Date().toISOString()

  // 1) Claim das agendadas vencidas — flip 'scheduled' → 'sending' por linha,
  //    só quem ainda está 'scheduled' (evita corrida entre ticks).
  const { data: due, error: dueErr } = await admin
    .from('broadcasts')
    .select('id')
    .eq('status', 'scheduled')
    .lte('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: true })
    .limit(MAX_BROADCASTS_PER_TICK)

  if (dueErr) {
    return NextResponse.json({ error: dueErr.message }, { status: 500 })
  }

  for (const b of due ?? []) {
    await admin
      .from('broadcasts')
      .update({ status: 'sending' })
      .eq('id', b.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle()
  }

  // 2) Processa todas as 'sending' (recém-claimed + retomadas), com teto global.
  const { data: sending, error: sendErr } = await admin
    .from('broadcasts')
    .select(SELECT_FIELDS)
    .eq('status', 'sending')
    .order('updated_at', { ascending: true })
    .limit(MAX_BROADCASTS_PER_TICK)

  if (sendErr) {
    return NextResponse.json({ error: sendErr.message }, { status: 500 })
  }

  let processed = 0
  let sent = 0
  let failed = 0
  let budget = GLOBAL_RECIPIENT_CAP

  for (const b of sending ?? []) {
    if (budget <= 0) break
    const limit = Math.min(PER_BROADCAST_LIMIT, budget)
    const r = await drainBroadcast(admin, b as ScheduledBroadcastRow, limit)
    sent += r.sent
    failed += r.failed
    budget -= r.sent + r.failed
    processed++
  }

  return NextResponse.json({ processed, sent, failed })
}
