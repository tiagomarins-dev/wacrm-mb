import { beforeEach, describe, expect, it, vi } from 'vitest'

// requireRole controlado por teste; toErrorResponse e as classes de erro reais
// (molde: conversations/[id]/route.test.ts).
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: vi.fn() }
})

import { DELETE, GET, POST } from './route'
import { ForbiddenError, requireRole, UnauthorizedError } from '@/lib/auth/account'

const TAG_ID = '11111111-2222-3333-4444-555555555555'
const PAIR_ID = '66666666-7777-8888-9999-000000000000'

// Fake encadeável: registra filtros/escritas por tabela e responde conforme o cenário.
function makeDb(opts: { tagFound?: boolean; insertError?: { code: string } | null } = {}) {
  const calls: { table: string; op: string; eqs: [string, unknown][]; payload?: unknown }[] = []
  function from(table: string) {
    const c = { table, op: 'select', eqs: [] as [string, unknown][], payload: undefined as unknown }
    calls.push(c)
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((c.op = 'insert'), (c.payload = p), b),
      delete: () => ((c.op = 'delete'), b),
      eq: (col: string, v: unknown) => (c.eqs.push([col, v]), b),
      order: () => b,
      maybeSingle: async () => ({ data: opts.tagFound === false ? null : { id: TAG_ID }, error: null }),
      then: (ok: (v: unknown) => unknown) => {
        if (c.op === 'insert') return ok({ data: null, error: opts.insertError ?? null })
        if (c.op === 'delete') return ok({ data: null, error: null })
        return ok({ data: [{ id: PAIR_ID, mb_course_id: 90 }], error: null })
      },
    }
    return b
  }
  return { supabase: { from } as never, calls }
}

function ctx(db: ReturnType<typeof makeDb>) {
  return { userId: 'u1', accountId: 'acc-1', role: 'admin', supabase: db.supabase } as never
}

function post(body: unknown) {
  return new Request('http://localhost/api/integrations/mb-class-sync', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/api/integrations/mb-class-sync', () => {
  it('401 sem sessão e 403 sem papel admin', async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new UnauthorizedError())
    expect((await GET()).status).toBe(401)
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError('nope'))
    expect((await POST(post({}))).status).toBe(403)
  })

  it('GET lista os pares filtrando a conta', async () => {
    const db = makeDb()
    vi.mocked(requireRole).mockResolvedValue(ctx(db))
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).pairs).toHaveLength(1)
    expect(db.calls[0].eqs).toContainEqual(['account_id', 'acc-1'])
  })

  it('POST 400 para curso, tag, nome ou corpo inválidos', async () => {
    vi.mocked(requireRole).mockResolvedValue(ctx(makeDb()))
    const cases = [
      { mb_course_id: '90', tag_id: TAG_ID },
      { mb_course_id: 0, tag_id: TAG_ID },
      { mb_course_id: 90, tag_id: 'x' },
      { mb_course_id: 90, tag_id: TAG_ID, mb_course_name: 'a'.repeat(201) },
    ]
    for (const body of cases) expect((await POST(post(body))).status).toBe(400)
    expect((await POST(post('não é json'))).status).toBe(400)
  })

  it('POST 404 quando a tag não é da conta', async () => {
    const db = makeDb({ tagFound: false })
    vi.mocked(requireRole).mockResolvedValue(ctx(db))
    const res = await POST(post({ mb_course_id: 90, tag_id: TAG_ID }))
    expect(res.status).toBe(404)
    expect(db.calls[0].eqs).toContainEqual(['account_id', 'acc-1'])
    expect(db.calls.some((c) => c.op === 'insert')).toBe(false)
  })

  it('POST 409 para par duplicado', async () => {
    vi.mocked(requireRole).mockResolvedValue(ctx(makeDb({ insertError: { code: '23505' } })))
    expect((await POST(post({ mb_course_id: 90, tag_id: TAG_ID }))).status).toBe(409)
  })

  it('POST 200 grava com a conta do contexto', async () => {
    const db = makeDb()
    vi.mocked(requireRole).mockResolvedValue(ctx(db))
    const res = await POST(post({ mb_course_id: 90, mb_course_name: 'MB Turbo 2026', tag_id: TAG_ID }))
    expect(res.status).toBe(200)
    expect(db.calls.find((c) => c.op === 'insert')?.payload).toEqual({
      account_id: 'acc-1',
      mb_course_id: 90,
      mb_course_name: 'MB Turbo 2026',
      tag_id: TAG_ID,
    })
  })

  it('DELETE 400 com id inválido e 200 filtrando id + conta', async () => {
    const db = makeDb()
    vi.mocked(requireRole).mockResolvedValue(ctx(db))
    const bad = await DELETE(new Request('http://localhost/api/integrations/mb-class-sync?id=x', { method: 'DELETE' }))
    expect(bad.status).toBe(400)
    const ok = await DELETE(
      new Request(`http://localhost/api/integrations/mb-class-sync?id=${PAIR_ID}`, { method: 'DELETE' }),
    )
    expect(ok.status).toBe(200)
    const del = db.calls.find((c) => c.op === 'delete')
    expect(del?.eqs).toEqual([
      ['id', PAIR_ID],
      ['account_id', 'acc-1'],
    ])
  })
})
