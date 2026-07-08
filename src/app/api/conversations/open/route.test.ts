// ============================================================
// Testa POST /api/conversations/open por invocação direta do handler
// (sem HTTP). Mocka supabase server + resolveOutboundConfig + findOrCreate.
// Cobre: 200 happy, 401/403/400/404, 400 sem conexão, idempotência,
// fallback de conexão nula → primária, e o guard de phone.
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// Estado compartilhado p/ o mock do supabase (hoisted p/ o vi.mock ler).
const h = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  account: 'a1' as string | null,
  contact: { id: 'c1', phone: '+5511999' } as
    | { id: string; phone: string | null }
    | null,
}))

// Builder mínimo: resolve por tabela no maybeSingle (igual evolution/connect).
vi.mock('@/lib/supabase/server', () => {
  function from(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: () => {
        if (table === 'profiles')
          return Promise.resolve({
            data: h.account ? { account_id: h.account } : null,
          })
        if (table === 'contacts') return Promise.resolve({ data: h.contact })
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

// Config resolvida + conversa criada mockadas (a rota só orquestra).
const resolveMock = vi.fn(async (..._a: unknown[]) => ({
  id: 'conn1',
  user_id: 'owner1',
  account_id: 'a1',
}))
vi.mock('@/lib/connections/resolve', () => ({
  resolveOutboundConfig: (...a: unknown[]) => resolveMock(...a),
}))
const findMock = vi.fn(async (..._a: unknown[]) => ({ id: 'conv1' }))
vi.mock('@/lib/whatsapp/inbound', () => ({
  findOrCreateConversation: (...a: unknown[]) => findMock(...a),
}))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://localhost/api/conversations/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  h.user = { id: 'u1' }
  h.account = 'a1'
  h.contact = { id: 'c1', phone: '+5511999' }
  resolveMock.mockResolvedValue({ id: 'conn1', user_id: 'owner1', account_id: 'a1' })
  findMock.mockResolvedValue({ id: 'conv1' })
  __resetRateLimitForTests()
})

describe('POST /api/conversations/open', () => {
  it('200 + conversation_id no happy path', async () => {
    const res = await POST(req({ contact_id: 'c1', connection_id: 'conn1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversation_id: 'conv1' })
  })

  it('401 sem user', async () => {
    h.user = null
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(401)
  })

  it('403 sem account', async () => {
    h.account = null
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(403)
  })

  it('400 sem contact_id', async () => {
    expect((await POST(req({}))).status).toBe(400)
  })

  it('404 contato de outra conta (não achado)', async () => {
    h.contact = null
    expect((await POST(req({ contact_id: 'cX' }))).status).toBe(404)
  })

  it('400 contato sem phone', async () => {
    h.contact = { id: 'c1', phone: null }
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(400)
  })

  it('400 conta sem conexão (resolve throw)', async () => {
    resolveMock.mockRejectedValueOnce(new Error('no conn'))
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(400)
  })

  it('idempotente: mesma conversa nas 2 chamadas', async () => {
    const a = await (await POST(req({ contact_id: 'c1' }))).json()
    const b = await (await POST(req({ contact_id: 'c1' }))).json()
    expect(a.conversation_id).toBe(b.conversation_id)
  })

  it('fallback: connection_id nulo → resolve chamado com null (primária)', async () => {
    await POST(req({ contact_id: 'c1' }))
    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), 'a1', null)
  })
})
