import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  return { ...actual, requireRole: vi.fn() }
})
vi.mock('@/lib/integrations/admin-client', () => ({ supabaseAdmin: vi.fn(() => ({})) }))
const h = vi.hoisted(() => ({ fetchCourseStudents: vi.fn(), resolveMbApiKey: vi.fn() }))
vi.mock('@/lib/mb-sync/platform-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mb-sync/platform-api')>()
  return { ...actual, fetchCourseStudents: h.fetchCourseStudents, resolveMbApiKey: h.resolveMbApiKey }
})

import { GET } from './route'
import { ForbiddenError, requireRole } from '@/lib/auth/account'
import { MbApiError } from '@/lib/mb-sync/platform-api'

const call = (id: string) => GET(new Request(`http://localhost/api/integrations/mb-class-sync/course?id=${id}`))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requireRole).mockResolvedValue({ accountId: 'acc-1', role: 'admin' } as never)
  h.resolveMbApiKey.mockResolvedValue('chave')
})

describe('GET /api/integrations/mb-class-sync/course', () => {
  it('403 sem papel admin', async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new ForbiddenError('nope'))
    expect((await call('90')).status).toBe(403)
    expect(h.fetchCourseStudents).not.toHaveBeenCalled()
  })

  it('400 com id inválido, sem chamar a API', async () => {
    for (const id of ['', 'abc', '0', '-1', '1e3']) expect((await call(id)).status).toBe(400)
    expect(h.fetchCourseStudents).not.toHaveBeenCalled()
  })

  it('503 sem chave configurada', async () => {
    h.resolveMbApiKey.mockResolvedValue(null)
    expect((await call('90')).status).toBe(503)
  })

  it('404 curso inexistente', async () => {
    h.fetchCourseStudents.mockResolvedValue({ found: false })
    expect((await call('999')).status).toBe(404)
  })

  it('429 no limite da API e 502 nos demais erros, sem expor o código', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.fetchCourseStudents.mockRejectedValueOnce(new MbApiError('rate_limited'))
    expect((await call('90')).status).toBe(429)
    h.fetchCourseStudents.mockRejectedValueOnce(new MbApiError('unauthorized'))
    const res = await call('90')
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('unauthorized')
  })

  it('200 devolve nome, situação e total de ativos (sem dados de aluno)', async () => {
    h.fetchCourseStudents.mockResolvedValue({
      found: true,
      curso: { id_curso: 90, nome_curso: 'MB Turbo 2026', vigente: 'S' },
      ativos: [{ id_aluno: 1, nome: 'Ana', telefone: '5521...' }, { id_aluno: 2 }],
    })
    const res = await call('90')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ course: { id_curso: 90, nome_curso: 'MB Turbo 2026', vigente: 'S', total_ativos: 2 } })
    expect(h.fetchCourseStudents).toHaveBeenCalledWith('chave', 90)
  })
})
