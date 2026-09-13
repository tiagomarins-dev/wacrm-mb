import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/integrations/admin-client'
import { fetchCourseStudents, MbApiError, resolveMbApiKey } from '@/lib/mb-sync/platform-api'

export const runtime = 'nodejs'

// GET ?id= — confere um curso da Plataforma MB pelo id antes de ligá-lo a uma tag
// (a API não lista cursos). Cada consulta consome a cota de 60/hora da chave.
export async function GET(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const raw = new URL(request.url).searchParams.get('id') ?? ''
    const id = /^\d{1,9}$/.test(raw) ? Number(raw) : 0
    if (id <= 0) return NextResponse.json({ error: 'id do curso inválido.' }, { status: 400 })

    // Chave (admin-only) via service-role; env como fallback — igual student-info.
    const apiKey = await resolveMbApiKey(supabaseAdmin(), ctx.accountId)
    if (!apiKey) {
      return NextResponse.json({ error: 'Chave da API da Plataforma MB não configurada.' }, { status: 503 })
    }

    const res = await fetchCourseStudents(apiKey, id)
    if (!res.found) return NextResponse.json({ error: 'Curso não encontrado.' }, { status: 404 })
    return NextResponse.json({
      course: {
        id_curso: res.curso.id_curso,
        nome_curso: res.curso.nome_curso,
        vigente: res.curso.vigente,
        total_ativos: res.ativos.length,
      },
    })
  } catch (err) {
    if (err instanceof MbApiError) {
      console.error('[mb-class-sync/course] api:', err.code)
      if (err.code === 'rate_limited') {
        return NextResponse.json({ error: 'Limite de consultas da Plataforma MB atingido. Tente mais tarde.' }, { status: 429 })
      }
      return NextResponse.json({ error: 'Não foi possível consultar a Plataforma MB.' }, { status: 502 })
    }
    return toErrorResponse(err)
  }
}
