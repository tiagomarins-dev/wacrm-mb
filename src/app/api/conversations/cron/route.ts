import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'

// Runtime Node: timingSafeEqual (node:crypto) + service-role exigem Node, nao Edge.
export const runtime = 'nodejs'

/**
 * Dois sweeps de manutencao de conversa, independentes entre si:
 *  - desatribuicao: conversa atribuida e parada (updated_at) alem do limite da
 *    conexao perde o responsavel (assigned_agent_id=NULL) e volta pra Fila;
 *  - fechamento: conversa aberta cuja ultima MENSAGEM passou do limite da
 *    conexao vira 'closed' (o time nao finaliza atendimento na mao).
 * Toda a regra mora nas funcoes SQL (045 e 080); este handler so autentica e
 * chama os .rpc(). Auth timing-safe com AUTOMATION_CRON_SECRET (mesmo secret
 * dos demais crons) — espelha flows/cron.
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

  // Sweeps rodam em sequencia e sao independentes: falha de um nao impede o
  // outro (fechar conversa velha nao pode parar de acontecer porque a
  // desatribuicao quebrou, e vice-versa). 500 so quando os dois falham.
  const admin = supabaseAdmin()
  const unassign = await admin.rpc('unassign_inactive_conversations')
  if (unassign.error) {
    console.error('[conversations/cron] unassign sweep failed:', unassign.error.message)
  }
  const close = await admin.rpc('close_inactive_conversations')
  if (close.error) {
    console.error('[conversations/cron] close sweep failed:', close.error.message)
  }
  if (unassign.error && close.error) {
    return NextResponse.json({ error: unassign.error.message }, { status: 500 })
  }
  return NextResponse.json({ released: unassign.data ?? 0, closed: close.data ?? 0 })
}
