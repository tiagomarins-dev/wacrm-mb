// ============================================================
// Testa isLoggedMemberClick: skip-membro do /r. Mocka @/lib/supabase/server.
// Cobre: sem cookie → false SEM instanciar client; membro → true; outra conta
// → false; erro → false (fail-open); negativo de B (contato sem cookie conta).
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'

// Estado hoisted p/ o vi.mock ler; `calls` conta quantas vezes createClient foi chamado.
const h = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  account: 'acc-1' as string | null,
  throwOnCreate: false,
  calls: 0,
}))

vi.mock('@/lib/supabase/server', () => {
  function from() {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: () =>
        Promise.resolve({ data: h.account ? { account_id: h.account } : null }),
    }
    return b
  }
  return {
    createClient: async () => {
      h.calls += 1
      if (h.throwOnCreate) throw new Error('boom')
      return {
        auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
        from,
      }
    },
  }
})

import { isLoggedMemberClick } from './member-click'

// Request com/sem cookie de sessão Supabase.
function req(cookie?: string) {
  return new Request('http://localhost/r/abc', {
    headers: cookie ? { cookie } : {},
  })
}

afterEach(() => {
  h.user = { id: 'u1' }
  h.account = 'acc-1'
  h.throwOnCreate = false
  h.calls = 0
})

describe('isLoggedMemberClick', () => {
  it('sem cookie sb- → false SEM instanciar o client', async () => {
    expect(await isLoggedMemberClick(req(), 'acc-1')).toBe(false)
    expect(h.calls).toBe(0)
  })

  it('negativo de B: contato sem cookie → false (o clique continua contando)', async () => {
    expect(await isLoggedMemberClick(req('outra=1'), 'acc-1')).toBe(false)
    expect(h.calls).toBe(0)
  })

  it('cookie + membro da conta → true', async () => {
    expect(await isLoggedMemberClick(req('sb-access-token=xyz'), 'acc-1')).toBe(true)
  })

  it('cookie + user de outra conta → false', async () => {
    h.account = 'acc-2'
    expect(await isLoggedMemberClick(req('sb-access-token=xyz'), 'acc-1')).toBe(false)
  })

  it('cookie mas sem user logado → false', async () => {
    h.user = null
    expect(await isLoggedMemberClick(req('sb-access-token=xyz'), 'acc-1')).toBe(false)
  })

  it('erro no client → false (fail-open)', async () => {
    h.throwOnCreate = true
    expect(await isLoggedMemberClick(req('sb-access-token=xyz'), 'acc-1')).toBe(false)
  })
})
