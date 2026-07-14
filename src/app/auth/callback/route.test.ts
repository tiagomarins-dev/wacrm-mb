// ============================================================
// Testa GET /auth/callback por invocação direta do handler.
// Mocka @/lib/supabase/server (exchangeCodeForSession). Cobre: sem code→/login;
// erro no exchange→/login; sucesso→next; next malicioso→/dashboard;
// /reset-password→/login; /join/<t> falho→/login?invite=<t>; next+code juntos.
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'

// Estado hoisted p/ o vi.mock: controla o resultado do exchange.
const h = vi.hoisted(() => ({ exchangeError: null as { message: string } | null }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({ error: h.exchangeError }),
    },
  }),
}))

import { GET } from './route'

function req(qs: string) {
  return new Request(`http://localhost/auth/callback${qs}`)
}
// Location relativa ao origin do request.
function loc(res: Response) {
  return new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search
}

afterEach(() => {
  h.exchangeError = null
})

describe('GET /auth/callback', () => {
  it('sem code → /login', async () => {
    const res = await GET(req('?next=/dashboard'))
    expect(loc(res)).toBe('/login')
  })

  it('erro no exchange → /login (fail-safe, sem 500)', async () => {
    h.exchangeError = { message: 'invalid code' }
    const res = await GET(req('?code=abc&next=/inbox'))
    expect(loc(res)).toBe('/login')
  })

  it('sucesso + next válido → next', async () => {
    const res = await GET(req('?code=abc&next=/inbox'))
    expect(loc(res)).toBe('/inbox')
  })

  it('next malicioso (//evil, https) → /dashboard', async () => {
    expect(loc(await GET(req('?code=abc&next=//evil.com')))).toBe('/dashboard')
    expect(loc(await GET(req('?code=abc&next=https://evil.com')))).toBe('/dashboard')
  })

  it('next=/reset-password → /login (rota inexistente)', async () => {
    const res = await GET(req('?code=abc&next=/reset-password'))
    expect(loc(res)).toBe('/login')
  })

  it('next=/join/<t> com falha → /login?invite=<t>', async () => {
    h.exchangeError = { message: 'bad' }
    const res = await GET(req('?code=abc&next=/join/tok123'))
    expect(loc(res)).toBe('/login?invite=tok123')
  })

  it('next E code juntos → sucesso segue pro next', async () => {
    const res = await GET(req('?next=/join/abc&code=pkce'))
    expect(loc(res)).toBe('/join/abc')
  })
})
