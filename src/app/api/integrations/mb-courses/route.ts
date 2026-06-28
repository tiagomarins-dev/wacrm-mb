import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import type { MbPaidCourse } from '@/types'
import type { StudentInfoResponse } from '@/lib/integrations/student-info'

export const runtime = 'nodejs'

// Cursos da MB vistos nesta conta (extraídos dos snapshots student_info) + o estado
// "conta como venda" (mb_paid_courses). Admin-only — usado na config de Integrações
// pra o admin marcar quais cursos pagam (bundle/grátis ficam de fora).

// GET — lista cursos vistos (distinct id_curso/nome) + enabled.
export async function GET() {
  try {
    const ctx = await requireRole('admin')

    // snapshots de aluno da conta (RLS já restringe; payload tem cursos_matriculados)
    const [{ data: snaps, error: snapErr }, { data: paid, error: paidErr }] = await Promise.all([
      ctx.supabase.from('student_info').select('payload').eq('account_id', ctx.accountId),
      ctx.supabase.from('mb_paid_courses').select('id_curso, nome_curso, enabled').eq('account_id', ctx.accountId),
    ])
    if (snapErr || paidErr) {
      return NextResponse.json({ error: 'Failed to load courses' }, { status: 500 })
    }

    const enabledById = new Map<number, boolean>(
      ((paid as { id_curso: number; enabled: boolean }[] | null) ?? []).map((p) => [p.id_curso, p.enabled]),
    )
    // dedup dos cursos vistos em todos os snapshots
    const seen = new Map<number, MbPaidCourse>()
    for (const row of ((snaps as { payload: StudentInfoResponse | null }[] | null) ?? [])) {
      for (const c of row.payload?.cursos_matriculados ?? []) {
        if (!seen.has(c.id_curso)) {
          seen.set(c.id_curso, {
            id_curso: c.id_curso,
            nome_curso: c.nome_curso ?? null,
            enabled: enabledById.get(c.id_curso) ?? false,
          })
        }
      }
    }
    // cursos já marcados que (ainda) não apareceram em nenhum snapshot recente
    for (const p of (paid as { id_curso: number; nome_curso: string | null; enabled: boolean }[] | null) ?? []) {
      if (!seen.has(p.id_curso)) seen.set(p.id_curso, { id_curso: p.id_curso, nome_curso: p.nome_curso, enabled: p.enabled })
    }

    const courses = [...seen.values()].sort((a, b) => (a.nome_curso ?? '').localeCompare(b.nome_curso ?? ''))
    return NextResponse.json({ courses })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST — marca/desmarca um curso como pago (upsert por conta+curso).
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json()) as { id_curso?: unknown; nome_curso?: unknown; enabled?: unknown }
    if (!Number.isInteger(body.id_curso) || typeof body.enabled !== 'boolean') {
      return NextResponse.json({ error: 'id_curso (int) e enabled (bool) obrigatórios.' }, { status: 400 })
    }
    const { error } = await ctx.supabase.from('mb_paid_courses').upsert(
      {
        account_id: ctx.accountId,
        id_curso: body.id_curso as number,
        nome_curso: typeof body.nome_curso === 'string' ? body.nome_curso : null,
        enabled: body.enabled,
      },
      { onConflict: 'account_id,id_curso' },
    )
    if (error) {
      return NextResponse.json(
        { error: (error as { code?: string })?.code === '42501' ? 'Apenas administradores.' : 'Failed to save' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
