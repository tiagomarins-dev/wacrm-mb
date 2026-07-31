import { describe, expect, it, beforeEach, vi } from 'vitest'

// Mock deps server-only (molde: broadcasts/cron/route.test.ts). requireRole é
// controlado por teste; toErrorResponse usa a implementação REAL (mapeia as
// classes de erro do módulo) — só o requireRole é substituído.
vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: vi.fn() }
})
vi.mock('@/lib/integrations/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return { ...actual, checkRateLimit: vi.fn(() => ({ success: true })) }
})

import { DELETE } from './route'
import { requireRole, UnauthorizedError, ForbiddenError } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/integrations/admin-client'

const OWNER_CTX = { userId: 'u1', accountId: 'acc-1', role: 'owner' } as never
const CONV_ID = '11111111-2222-3333-4444-555555555555'

// Builder fake encadeável: registra filtros e resolve com o payload configurado.
function makeDb(result: { data: unknown[] | null; error?: { code?: string; message: string } | null }) {
  const filters: [string, ...unknown[]][] = []
  const b: Record<string, unknown> = {
    delete: () => b,
    eq: (...a: unknown[]) => {
      filters.push(['eq', ...a])
      return b
    },
    select: () => b,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: result.data, error: result.error ?? null }),
  }
  const db = { from: vi.fn(() => b) }
  return { db: db as never, filters, from: db.from }
}

function req() {
  return new Request('http://localhost/api/conversations/x', { method: 'DELETE' })
}
function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireRole).mockResolvedValue(OWNER_CTX)
})

describe('DELETE /api/conversations/[id]', () => {
  it('owner deleta conversa da conta → 200, escopado por account_id', async () => {
    const { db, filters } = makeDb({ data: [{ id: CONV_ID }] })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await DELETE(req(), params(CONV_ID))
    expect(res.status).toBe(200)
    // Barreira de tenant: service-role bypassa RLS, o filtro é obrigatório.
    expect(filters).toContainEqual(['eq', 'account_id', 'acc-1'])
    expect(filters).toContainEqual(['eq', 'id', CONV_ID])
  })

  it('não-owner → 403', async () => {
    vi.mocked(requireRole).mockRejectedValue(new ForbiddenError('nope'))
    const res = await DELETE(req(), params(CONV_ID))
    expect(res.status).toBe(403)
  })

  it('sem sessão → 401', async () => {
    vi.mocked(requireRole).mockRejectedValue(new UnauthorizedError())
    const res = await DELETE(req(), params(CONV_ID))
    expect(res.status).toBe(401)
  })

  it('0 rows (outra conta/inexistente) → 404', async () => {
    const { db } = makeDb({ data: [] })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await DELETE(req(), params(CONV_ID))
    expect(res.status).toBe(404)
  })

  it('id não-UUID → 404 sem tocar o banco', async () => {
    const { db, from } = makeDb({ data: [] })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await DELETE(req(), params('nao-e-uuid'))
    expect(res.status).toBe(404)
    expect(from).not.toHaveBeenCalled()
  })

  it('FK de deals (23503) → 409 com mensagem amigável', async () => {
    const { db } = makeDb({ data: null, error: { code: '23503', message: 'fk violation' } })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await DELETE(req(), params(CONV_ID))
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('negócio vinculado')
  })
})
