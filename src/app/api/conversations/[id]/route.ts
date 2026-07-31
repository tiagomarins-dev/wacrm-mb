import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/integrations/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// DELETE /api/conversations/[id] — apaga a conversa INTEIRA (reset de teste de
// agente de IA). Owner-only: ação irreversível em produção. O cascade do banco
// zera mensagens/fila do agente/eventos; ai_agent_runs fica com conversation_id
// null (histórico de custo preservado). deals é NO ACTION → 409 quando houver
// negócio vinculado. Service-role bypassa RLS → o .eq(account_id) é a barreira
// de tenant — não remover.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const ctx = await requireRole('owner')

    // Rate-limit por usuário: uso legítimo é esporádico (reset de teste).
    const limit = checkRateLimit(`conv-delete:${ctx.userId}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    // Id não-UUID iria cru ao Postgres (22P02 → 500). 404 genérico, sem vazar.
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const { data, error } = await supabaseAdmin()
      .from('conversations')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')

    if (error) {
      // FK NO ACTION de deals: conversa com negócio no pipeline não some.
      if (error.code === '23503') {
        return NextResponse.json(
          { error: 'Conversa tem negócio vinculado no pipeline' },
          { status: 409 },
        )
      }
      console.error('[conversations] delete failed:', error.message)
      return NextResponse.json(
        { error: 'Failed to delete conversation' },
        { status: 500 },
      )
    }
    // 0 rows = não existe ou é de outra conta — 404 único (anti-enumeração).
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
