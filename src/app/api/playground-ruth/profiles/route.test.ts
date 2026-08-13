import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// Mock do service-role client: importar a rota não pode tocar Supabase real.
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn() }))

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { GET } from './route'

const SENHA = 'senha-de-teste-playground-24ch'

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/playground-ruth/profiles', { headers })
}
const authed = () => req({ 'x-playground-password': SENHA })

// db fake: ai_profiles com builder encadeável; captura os eq() pra assert de conta.
function makeDb(rows: Record<string, unknown>[]) {
  const eqs: [string, unknown][] = []
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (c: string, v: unknown) => (eqs.push([c, v]), b),
    order: () => Promise.resolve({ data: rows, error: null }),
    // caminho do resolvePlaygroundAccountId (select sem order): thenable
    then: (f: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(f),
  }
  return { db: { from: () => b } as never, eqs }
}

describe('GET /api/playground-ruth/profiles', () => {
  const original = process.env.PLAYGROUND_RUTH_PASSWORD
  beforeEach(() => {
    __resetRateLimitForTests()
    process.env.PLAYGROUND_RUTH_PASSWORD = SENHA
    delete process.env.PLAYGROUND_RUTH_ACCOUNT_ID
  })
  afterEach(() => {
    if (original === undefined) delete process.env.PLAYGROUND_RUTH_PASSWORD
    else process.env.PLAYGROUND_RUTH_PASSWORD = original
  })

  it('503 sem env de senha', async () => {
    delete process.env.PLAYGROUND_RUTH_PASSWORD
    expect((await GET(req())).status).toBe(503)
  })

  it('401 com senha errada', async () => {
    expect((await GET(req({ 'x-playground-password': 'x' }))).status).toBe(401)
  })

  it('404 sem nenhum perfil cadastrado', async () => {
    const { db } = makeDb([])
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    expect((await GET(authed())).status).toBe(404)
  })

  it('409 com duas contas e sem env âncora', async () => {
    const { db } = makeDb([{ account_id: 'acc-1' }, { account_id: 'acc-2' }])
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    expect((await GET(authed())).status).toBe(409)
  })

  it('200 com perfis, filtrando pela conta-âncora', async () => {
    const rows = [{ account_id: 'acc-1', id: 'p1', nome: 'Ruth' }]
    const { db, eqs } = makeDb(rows)
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await GET(authed())
    expect(res.status).toBe(200)
    const body = (await res.json()) as { profiles: unknown[] }
    expect(body.profiles).toHaveLength(1)
    // a listagem filtrou explicitamente por account_id (service-role bypassa RLS)
    expect(eqs).toContainEqual(['account_id', 'acc-1'])
  })
})
