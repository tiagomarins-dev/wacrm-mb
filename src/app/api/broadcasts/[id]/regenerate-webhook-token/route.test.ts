// Testa a regeneração de token do blueprint: auth, ownership, guarda de status.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  user: null as { id: string } | null,
  broadcast: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: store.user } }) },
  }),
}))

vi.mock('@/lib/broadcast/admin-client', () => ({
  supabaseAdmin: () => ({
    from() {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: store.broadcast, error: null }),
        update: (payload: Record<string, unknown>) => ({
          eq: async () => {
            store.updated = payload
            return { error: null }
          },
        }),
      }
      return b
    },
  }),
}))

import { POST } from './route'

function call(id = 'bp-1') {
  return POST(new Request('http://localhost/x', { method: 'POST' }), {
    params: Promise.resolve({ id }),
  })
}

beforeEach(() => {
  store.user = { id: 'u1' }
  store.broadcast = { id: 'bp-1', user_id: 'u1', status: 'webhook' }
  store.updated = null
})

describe('POST /api/broadcasts/[id]/regenerate-webhook-token', () => {
  it('401 sem sessão', async () => {
    store.user = null
    expect((await call()).status).toBe(401)
  })

  it('404 broadcast de outro user (ownership no filtro)', async () => {
    store.broadcast = null
    expect((await call()).status).toBe(404)
  })

  it('400 quando não é blueprint webhook', async () => {
    store.broadcast = { id: 'bp-1', user_id: 'u1', status: 'sent' }
    expect((await call()).status).toBe(400)
  })

  it('200 gera token bh_ novo e grava', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.webhook_token).toMatch(/^bh_[0-9a-f]{32}$/)
    expect(store.updated?.webhook_token).toBe(body.webhook_token)
  })
})
