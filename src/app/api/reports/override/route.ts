import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { OverrideBody } from '@/types'

export const runtime = 'nodejs'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Override admin de venda atribuída (Fase 3): cancelar (status='reverted') ou
 * reatribuir (atendente_id). `attributed_sales` não tem write policy, então o
 * UPDATE vai por service-role (supabaseAdmin) — o isolamento de tenant é feito
 * NO CÓDIGO via .eq('account_id', ctx.accountId).eq('id', sale_id).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json()) as Partial<OverrideBody>

    // validação do corpo
    if (!body.sale_id || !UUID_RE.test(body.sale_id)) {
      return NextResponse.json({ error: 'sale_id inválido.' }, { status: 400 })
    }
    if (body.action !== 'cancel' && body.action !== 'reassign') {
      return NextResponse.json({ error: 'action deve ser cancel|reassign.' }, { status: 400 })
    }

    const patch: Record<string, unknown> = {
      overridden_by: ctx.userId,
      override_reason: typeof body.reason === 'string' ? body.reason : null,
      overridden_at: new Date().toISOString(),
    }
    if (body.action === 'cancel') {
      patch.status = 'reverted'
    } else {
      // reassign: o novo atendente TEM que ser membro da MESMA conta (anti-IDOR)
      if (!body.new_agent_id || !UUID_RE.test(body.new_agent_id)) {
        return NextResponse.json({ error: 'new_agent_id inválido.' }, { status: 400 })
      }
      const { data: member } = await ctx.supabase
        .from('profiles').select('user_id').eq('user_id', body.new_agent_id).eq('account_id', ctx.accountId).maybeSingle()
      if (!member) {
        return NextResponse.json({ error: 'Atendente não pertence à conta.' }, { status: 400 })
      }
      patch.atendente_id = body.new_agent_id
    }

    // service-role + scoping manual por conta + id (isolamento de tenant)
    const { data, error } = await supabaseAdmin()
      .from('attributed_sales')
      .update(patch)
      .eq('account_id', ctx.accountId)
      .eq('id', body.sale_id)
      .select('id')
    if (error) {
      console.error('[reports/override] update failed:', error.message)
      return NextResponse.json({ error: 'Failed to override' }, { status: 500 })
    }
    if (!data || data.length === 0) {
      return NextResponse.json({ error: 'Venda não encontrada.' }, { status: 404 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
