import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { LeadScoreConfig } from '@/types'

export const runtime = 'nodejs'

// Config do Lead Score (pesos/janela/limiares), account-level, admin-only.
// Espelha src/app/api/integrations/config/route.ts. RLS já restringe a
// tabela a admin; requireRole('admin') é a 2ª camada.

// Defaults = os mesmos do migration 031 (usados quando não há linha salva).
const DEFAULTS: LeadScoreConfig = {
  msg_weight: 1,
  button_weight: 3,
  link_weight: 5,
  sale_multiplier: 2,
  window_days: 30,
  hot_threshold: 50,
  warm_threshold: 20,
}

// GET — devolve a config (com defaults preenchidos).
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data } = await ctx.supabase
      .from('lead_score_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    return NextResponse.json({
      ...DEFAULTS,
      ...((data as Partial<LeadScoreConfig> | null) ?? {}),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST — salva (upsert). Valida pesos ≥0, hot>warm, janela 1..365.
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const b = (await request.json()) as Record<string, unknown>
    // inteiro ≥0 com fallback; multiplicador aceita decimal.
    const int = (v: unknown, d: number) =>
      Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : d
    const num = (v: unknown, d: number) =>
      Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d

    const payload = {
      account_id: ctx.accountId,
      msg_weight: int(b.msg_weight, 1),
      button_weight: int(b.button_weight, 3),
      link_weight: int(b.link_weight, 5),
      sale_multiplier: num(b.sale_multiplier, 2),
      window_days: Math.min(Math.max(int(b.window_days, 30), 1), 365),
      hot_threshold: int(b.hot_threshold, 50),
      warm_threshold: int(b.warm_threshold, 20),
    }
    // hot precisa ser > warm pra classificação fazer sentido.
    if (payload.hot_threshold <= payload.warm_threshold) {
      return NextResponse.json(
        { error: 'O limiar "Quente" deve ser maior que o "Morno".' },
        { status: 400 },
      )
    }

    const { error } = await ctx.supabase
      .from('lead_score_config')
      .upsert(payload, { onConflict: 'account_id' })
    if (error) {
      console.error('[lead-score/config] upsert failed:', error.message)
      return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
