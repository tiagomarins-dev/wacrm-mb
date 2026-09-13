import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'

export const runtime = 'nodejs'

// De→para curso da Plataforma MB × tag (mig 086). Admin-only; RLS reforça.
// O cron /api/mb-sync/cron (service-role) confia nesses pares, por isso a tag é
// validada contra a conta no POST.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_COURSE_NAME = 200

// GET — pares da conta com nome/cor da tag.
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data, error } = await ctx.supabase
      .from('mb_class_sync')
      .select('id, mb_course_id, mb_course_name, tag_id, created_at, tag:tags(name, color)')
      .eq('account_id', ctx.accountId)
      .order('mb_course_name', { ascending: true })
    if (error) return NextResponse.json({ error: 'Failed to load pairs' }, { status: 500 })
    return NextResponse.json({ pairs: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST — cria um par; a tag precisa ser da conta.
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json().catch(() => null)) as {
      mb_course_id?: unknown
      mb_course_name?: unknown
      tag_id?: unknown
    } | null
    const courseId = body?.mb_course_id
    const tagId = body?.tag_id
    const name = body?.mb_course_name
    const validCourse = Number.isInteger(courseId) && (courseId as number) > 0
    const validTag = typeof tagId === 'string' && UUID_RE.test(tagId)
    const validName =
      name === undefined || name === null || (typeof name === 'string' && name.length <= MAX_COURSE_NAME)
    if (!validCourse || !validTag || !validName) {
      return NextResponse.json(
        { error: 'mb_course_id (int), tag_id (uuid) e mb_course_name (≤200) inválidos.' },
        { status: 400 },
      )
    }

    const { data: tag } = await ctx.supabase
      .from('tags')
      .select('id')
      .eq('id', tagId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!tag) return NextResponse.json({ error: 'Tag não encontrada.' }, { status: 404 })

    const { error } = await ctx.supabase.from('mb_class_sync').insert({
      account_id: ctx.accountId,
      mb_course_id: courseId as number,
      mb_course_name: typeof name === 'string' ? name : null,
      tag_id: tagId,
    })
    if (error) {
      const code = (error as { code?: string }).code
      if (code === '23505') return NextResponse.json({ error: 'Esse par já existe.' }, { status: 409 })
      if (code === '42501') return NextResponse.json({ error: 'Apenas administradores.' }, { status: 403 })
      return NextResponse.json({ error: 'Failed to save' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// DELETE ?id= — remove o par (a tag fica com os membros atuais).
export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const id = new URL(request.url).searchParams.get('id')
    if (!id || !UUID_RE.test(id)) return NextResponse.json({ error: 'id inválido.' }, { status: 400 })
    const { error } = await ctx.supabase
      .from('mb_class_sync')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
    if (error) return NextResponse.json({ error: 'Failed to delete' }, { status: 500 })
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
