// Testa a criação de blueprint: auth, validações e token bh_ no retorno.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  user: null as { id: string } | null,
  accountId: null as string | null,
  connection: null as { id: string } | null,
  inserted: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: store.user } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () =>
            table === 'profiles'
              ? { data: store.accountId ? { account_id: store.accountId } : null }
              : { data: null },
        }),
      }),
    }),
  }),
}))

vi.mock('@/lib/broadcast/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === 'whatsapp_config') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: store.connection, error: null }),
        }
        return b
      }
      if (table === 'broadcasts') {
        return {
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                store.inserted = row
                return {
                  data: { id: 'bp-1', webhook_token: row.webhook_token },
                  error: null,
                }
              },
            }),
          }),
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function call(body: unknown) {
  return POST(
    new Request('http://localhost/api/broadcasts/blueprint', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const VALID_BODY = {
  name: 'Aviso de aula',
  connection_id: 'conn-1',
  template_name: 'lembrete_aula',
  template_language: 'pt_BR',
  template_variables: { '1': { type: 'payload', value: 'link_aula' } },
  audience_filter: { type: 'tags', tagIds: ['t1'] },
}

beforeEach(() => {
  __resetRateLimitForTests()
  store.user = { id: 'u1' }
  store.accountId = 'acct-1'
  store.connection = { id: 'conn-1' }
  store.inserted = null
})

describe('POST /api/broadcasts/blueprint', () => {
  it('401 sem sessão', async () => {
    store.user = null
    expect((await call(VALID_BODY)).status).toBe(401)
  })

  it('403 sem conta vinculada', async () => {
    store.accountId = null
    expect((await call(VALID_BODY)).status).toBe(403)
  })

  it('400 sem campos obrigatórios', async () => {
    expect((await call({ ...VALID_BODY, name: '' })).status).toBe(400)
    expect((await call({ ...VALID_BODY, connection_id: undefined })).status).toBe(400)
  })

  it('400 audiência fora de all/tags', async () => {
    const res = await call({ ...VALID_BODY, audience_filter: { type: 'csv' } })
    expect(res.status).toBe(400)
  })

  it('400 variável com type inválido', async () => {
    const res = await call({
      ...VALID_BODY,
      template_variables: { '1': { type: 'hacker', value: 'x' } },
    })
    expect(res.status).toBe(400)
  })

  it('400 conexão de outra conta', async () => {
    store.connection = null
    expect((await call(VALID_BODY)).status).toBe(400)
  })

  it('201 cria blueprint status webhook com token bh_', async () => {
    const res = await call(VALID_BODY)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.id).toBe('bp-1')
    expect(body.webhook_token).toMatch(/^bh_[0-9a-f]{32}$/)
    expect(store.inserted).toMatchObject({
      status: 'webhook',
      scheduled_at: null,
      total_recipients: 0,
      account_id: 'acct-1',
      connection_id: 'conn-1',
    })
  })
})
