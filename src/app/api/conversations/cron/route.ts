import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// Runtime Node: timingSafeEqual (node:crypto) + service-role exigem Node, nao Edge.
export const runtime = 'nodejs'

/**
 * Sweep de desatribuicao automatica: conversa atribuida e parada (updated_at)
 * alem do limite da conexao perde o responsavel (assigned_agent_id=NULL) e volta
 * pra Fila. Toda a regra mora na funcao SQL unassign_inactive_conversations();
 * este handler so autentica e chama o .rpc(). Auth timing-safe com
 * AUTOMATION_CRON_SECRET (mesmo secret dos demais crons) — espelha flows/cron.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Comparacao constant-time: impede recuperar o secret por timing. O pre-check
  // de tamanho e exigido pelo timingSafeEqual (vaza so o tamanho, nao sensivel).
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin().rpc('unassign_inactive_conversations')
  if (error) {
    console.error('[conversations/cron] sweep failed:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ released: data ?? 0 })
}
