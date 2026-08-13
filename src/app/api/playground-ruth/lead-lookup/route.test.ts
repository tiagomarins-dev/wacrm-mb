import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn() }))

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { POST } from './route'

const SENHA = 'senha-de-teste-playground-24ch'

function req(body: unknown) {
  return new Request('http://localhost/api/playground-ruth/lead-lookup', {
    method: 'POST',
    headers: { 'x-playground-password': SENHA, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// db fake por tabela: ai_profiles (âncora), contacts (matches) e
// broadcast_recipients (lead_context). Captura o pattern do like().
function makeDb(opts: {
  contacts?: { id: string; name: string | null; phone: string | null }[]
  leadContext?: Record<string, string> | null
}) {
  const likes: string[] = []
  const from = (table: string) => {
    const rows =
      table === 'ai_profiles'
        ? [{ account_id: 'acc-1' }]
        : table === 'contacts'
          ? (opts.contacts ?? [])
          : table === 'broadcast_recipients'
            ? opts.leadContext !== undefined && opts.leadContext !== null
              ? [{ lead_context: opts.leadContext }]
              : []
            : []
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      not: () => b,
      order: () => b,
      like: (_c: string, p: string) => (likes.push(p), b),
      limit: () => Promise.resolve({ data: rows, error: null }),
      then: (f: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(f),
    }
    return b
  }
  return { db: { from } as never, likes }
}

describe('POST /api/playground-ruth/lead-lookup', () => {
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

  it('422 com sufixo curto demais', async () => {
    expect((await POST(req({ phoneSuffix: '123' }))).status).toBe(422)
  })

  it('curingas %/_ são removidos (nunca chegam ao LIKE) e sobra curto → 422', async () => {
    // "%99_9" vira "999" (3 dígitos) → 422; nenhum like() executado
    const { db, likes } = makeDb({})
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    expect((await POST(req({ phoneSuffix: '%99_9' }))).status).toBe(422)
    expect(likes).toHaveLength(0)
  })

  it('sufixo válido com curinga no meio: só os dígitos entram no pattern', async () => {
    const { db, likes } = makeDb({ contacts: [] })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await POST(req({ phoneSuffix: '9%8_7 6-5' }))
    expect(res.status).toBe(200)
    expect(likes).toEqual(['%98765'])
  })

  it('200 mascarado: phoneLast4 e só CHAVES do lead_context (nunca valores)', async () => {
    const { db } = makeDb({
      contacts: [{ id: 'ct-1', name: 'Fulana', phone: '5521998768899' }],
      leadContext: { objetivo: 'medicina', dificuldade: 'argumentação' },
    })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await POST(req({ phoneSuffix: '8899' }))
    const body = (await res.json()) as { matches: Record<string, unknown>[] }
    expect(body.matches).toHaveLength(1)
    expect(body.matches[0]).toEqual({
      contactId: 'ct-1',
      name: 'Fulana',
      phoneLast4: '8899',
      hasLeadContext: true,
      leadContextKeys: ['objetivo', 'dificuldade'],
    })
    // o payload inteiro não pode conter o telefone completo nem valores da pesquisa
    const raw = JSON.stringify(body)
    expect(raw).not.toContain('5521998768899')
    expect(raw).not.toContain('medicina')
  })

  it('match sem pesquisa → hasLeadContext false e zero chaves', async () => {
    const { db } = makeDb({
      contacts: [{ id: 'ct-2', name: null, phone: '5521911112222' }],
      leadContext: null,
    })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await POST(req({ phoneSuffix: '2222' }))
    const body = (await res.json()) as { matches: Record<string, unknown>[] }
    expect(body.matches[0]).toMatchObject({ hasLeadContext: false, leadContextKeys: [] })
  })
})
