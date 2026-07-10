// ============================================================
// Testa POST /api/link-tokens/resolve por invocação direta do handler.
// Mocka supabase server (auth+profiles) e supabaseAdmin (link_tokens store).
// Cobre: 401, 403, 400 (não-array/>200), account-scope (token de outra conta
// ausente), filtro de formato hex, happy.
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const h = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  account: 'acc-1' as string | null,
}))

vi.mock('@/lib/supabase/server', () => {
  function from(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: () => {
        if (table === 'profiles')
          return Promise.resolve({ data: h.account ? { account_id: h.account } : null })
        return Promise.resolve({ data: null })
      },
    }
    return b
  }
  return {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
      from,
    }),
  }
})

// Store de link_tokens do admin client: filtra por in(tokens) + eq(account_id) — igual à query real.
const STORE = [
  { id: 'a'.repeat(32), url: 'https://real.com/1', account_id: 'acc-1' },
  { id: 'b'.repeat(32), url: 'https://real.com/2', account_id: 'acc-2' }, // outra conta
]
vi.mock('@/lib/flows/admin-client', () => {
  function makeQuery() {
    let ids: string[] = []
    let account = ''
    const q: Record<string, unknown> = {
      select: () => q,
      in: (_col: string, v: string[]) => ((ids = v), q),
      eq: (_col: string, v: string) => ((account = v), q),
      then: (f: (r: unknown) => unknown) =>
        Promise.resolve({
          data: STORE.filter((r) => ids.includes(r.id) && r.account_id === account),
          error: null,
        }).then(f),
    }
    return q
  }
  return { supabaseAdmin: () => ({ from: () => makeQuery() }) }
})

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://localhost/api/link-tokens/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  h.user = { id: 'u1' }
  h.account = 'acc-1'
  __resetRateLimitForTests()
})

describe('POST /api/link-tokens/resolve', () => {
  it('sem user → 401', async () => {
    h.user = null
    const res = await POST(req({ tokens: [] }))
    expect(res.status).toBe(401)
  })

  it('sem account → 403', async () => {
    h.account = null
    const res = await POST(req({ tokens: [] }))
    expect(res.status).toBe(403)
  })

  it('tokens não-array → 400', async () => {
    const res = await POST(req({ tokens: 'x' }))
    expect(res.status).toBe(400)
  })

  it('tokens > 200 → 400', async () => {
    const res = await POST(req({ tokens: new Array(201).fill('a'.repeat(32)) }))
    expect(res.status).toBe(400)
  })

  it('account-scope: token de outra conta ausente no map', async () => {
    const res = await POST(req({ tokens: ['a'.repeat(32), 'b'.repeat(32)] }))
    expect(res.status).toBe(200)
    const { map } = await res.json()
    expect(map['a'.repeat(32)]).toBe('https://real.com/1')
    expect(map['b'.repeat(32)]).toBeUndefined() // acc-2 filtrado
  })

  it('filtro de formato: token malformado é descartado → map vazio', async () => {
    const res = await POST(req({ tokens: ['nao-hex', 'ABC'] }))
    expect(res.status).toBe(200)
    const { map } = await res.json()
    expect(map).toEqual({})
  })
})
