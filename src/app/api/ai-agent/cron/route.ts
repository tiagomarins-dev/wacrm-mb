import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runAiAgentForConversation, type PendingRow } from '@/lib/ai-agent/engine'

/**
 * Drena a fila `ai_agent_pending` — conversas maduras (run_at vencido) que
 * o agente de IA deve responder. Pingado pelo sidecar de cron a cada
 * CRON_INTERVAL; exige `x-cron-secret` = AUTOMATION_CRON_SECRET (mesmo
 * secret dos outros crons). Espelha automations/cron/route.ts.
 *
 * O claim (status='running') serve de lock: invocações sobrepostas não
 * processam a mesma conversa duas vezes (UPDATE ... WHERE status='pending').
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  // Limite por tick (H2): teto de carga/custo por invocação.
  const { data: due, error } = await admin
    .from('ai_agent_pending')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    // Claim atômico: só uma invocação ganha a row.
    const { data: claim } = await admin
      .from('ai_agent_pending')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    try {
      await runAiAgentForConversation(row as PendingRow)
      // Sucesso → remove a pendência (ack).
      await admin.from('ai_agent_pending').delete().eq('id', row.id)
    } catch (err) {
      console.error('[ai_agent] run failed:', err instanceof Error ? err.message : err)
      await admin
        .from('ai_agent_pending')
        .update({ status: 'error', attempts: ((row.attempts as number) ?? 0) + 1 })
        .eq('id', row.id)
    }
    processed++
  }

  return NextResponse.json({ processed })
}
