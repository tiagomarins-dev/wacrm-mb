// ============================================================
// Testa a rota pública POST /api/broadcasts/webhook/[token] por
// invocação direta. Mocka admin client + audiência; rate limit REAL
// (com reset) pra provar o bucket por IP. Cobre a ordem
// draft → recipients → sending (H1) e o rollback da idempotency key
// em falha pós-consumo (M1).
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  blueprint: null as Record<string, unknown> | null,
  audience: [] as { id: string }[],
  audienceThrows: false,
  idemInsertError: null as { code: string } | null,
  idemInserts: [] as Record<string, unknown>[],
  idemDeletes: 0,
  cloneInsertError: null as { message: string } | null,
  recipientInsertError: null as { message: string } | null,
  recipientInserts: [] as Record<string, unknown>[][],
  broadcastInserts: [] as Record<string, unknown>[],
  broadcastUpdates: [] as { payload: Record<string, unknown>; id?: string }[],
  // ordem dos efeitos, pra provar draft→recipients→sending
  ops: [] as string[],
}))

vi.mock('@/lib/broadcast/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === 'broadcasts') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: store.blueprint, error: null }),
          insert: (row: Record<string, unknown>) => ({
            select: () => ({
              single: async () => {
                if (store.cloneInsertError) {
                  return { data: null, error: store.cloneInsertError }
                }
                store.broadcastInserts.push(row)
                store.ops.push(`insert-broadcast:${row.status}`)
                return { data: { id: 'clone-1' }, error: null }
              },
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: async (_c: string, id: string) => {
              store.broadcastUpdates.push({ payload, id })
              store.ops.push(`update-broadcast:${payload.status}`)
              return { error: null }
            },
          }),
        }
        return b
      }
      if (table === 'broadcast_webhook_events') {
        return {
          insert: async (row: Record<string, unknown>) => {
            store.idemInserts.push(row)
            store.ops.push('idem-insert')
            return { error: store.idemInsertError }
          },
          delete: () => ({
            eq: () => ({
              eq: async () => {
                store.idemDeletes++
                store.ops.push('idem-delete')
                return { error: null }
              },
            }),
          }),
        }
      }
      if (table === 'broadcast_recipients') {
        return {
          insert: async (rows: Record<string, unknown>[]) => {
            if (store.recipientInsertError) return { error: store.recipientInsertError }
            store.recipientInserts.push(rows)
            store.ops.push(`insert-recipients:${rows.length}`)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/broadcast/audience', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./../../../../../lib/broadcast/audience')>()
  return {
    ...orig,
    resolveBlueprintAudience: vi.fn(async () => {
      if (store.audienceThrows) throw new Error('unsupported audience type: csv')
      return store.audience
    }),
  }
})

import { POST } from './route'
import { resolveBlueprintAudience } from '@/lib/broadcast/audience'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const TOKEN = 'bh_' + 'a'.repeat(32)

function blueprintFixture() {
  return {
    id: 'bp-1',
    user_id: 'u1',
    account_id: 'acct-1',
    connection_id: 'conn-1',
    name: 'Aviso de aula',
    template_name: 'lembrete_aula',
    template_language: 'pt_BR',
    template_variables: {
      '1': { type: 'payload', value: 'link_aula' },
      '2': { type: 'field', value: 'name' },
    },
    audience_filter: { type: 'tags', tagIds: ['t1'] },
  }
}

function call(
  body: unknown,
  opts: { token?: string; headers?: Record<string, string>; query?: string } = {},
) {
  const req = new Request(
    `http://localhost/api/broadcasts/webhook/x${opts.query ?? ''}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'aula-1',
        ...(opts.headers ?? {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  )
  return POST(req, { params: Promise.resolve({ token: opts.token ?? TOKEN }) })
}

beforeEach(() => {
  __resetRateLimitForTests()
  store.blueprint = null
  store.audience = []
  store.audienceThrows = false
  store.idemInsertError = null
  store.idemInserts = []
  store.idemDeletes = 0
  store.cloneInsertError = null
  store.recipientInsertError = null
  store.recipientInserts = []
  store.broadcastInserts = []
  store.broadcastUpdates = []
  store.ops = []
  vi.mocked(resolveBlueprintAudience).mockClear()
})

describe('validações', () => {
  it('400 sem X-Idempotency-Key', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      body: '{}',
    })
    const res = await POST(req, { params: Promise.resolve({ token: TOKEN }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain('X-Idempotency-Key')
  })

  it('400 key > 200 chars', async () => {
    const res = await call({}, { headers: { 'x-idempotency-key': 'k'.repeat(201) } })
    expect(res.status).toBe(400)
  })

  it('413 body > 32KB', async () => {
    const res = await call({ blob: 'x'.repeat(33 * 1024) })
    expect(res.status).toBe(413)
  })

  it('400 JSON não-objeto', async () => {
    expect((await call('[]')).status).toBe(400)
    expect((await call('not-json')).status).toBe(400)
  })
})

describe('resolução do blueprint', () => {
  it('404 genérico pra token desconhecido', async () => {
    const res = await call({ link_aula: 'x' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found')
  })

  it('404 quando blueprint sem conexão', async () => {
    store.blueprint = { ...blueprintFixture(), connection_id: null }
    const res = await call({ link_aula: 'x' })
    expect(res.status).toBe(404)
  })

  it('400 missing_keys lista as chaves ausentes', async () => {
    store.blueprint = blueprintFixture()
    const res = await call({})
    expect(res.status).toBe(400)
    expect((await res.json()).missing_keys).toEqual(['link_aula'])
    expect(store.idemInserts).toHaveLength(0)
  })

  it('400 invalid_keys pra valor não-primitivo', async () => {
    store.blueprint = blueprintFixture()
    const res = await call({ link_aula: { nested: true } })
    expect(res.status).toBe(400)
    expect((await res.json()).invalid_keys).toEqual(['link_aula'])
  })

  it('400 audiência não suportada', async () => {
    store.blueprint = blueprintFixture()
    store.audienceThrows = true
    const res = await call({ link_aula: 'x' })
    expect(res.status).toBe(400)
  })
})

describe('dry-run e audiência vazia', () => {
  it('?dry=1 retorna contagem sem criar nada nem consumir a key', async () => {
    store.blueprint = blueprintFixture()
    store.audience = [{ id: 'c1' }, { id: 'c2' }]
    const res = await call({ link_aula: 'x' }, { query: '?dry=1' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, dry: true, count: 2 })
    expect(store.idemInserts).toHaveLength(0)
    expect(store.broadcastInserts).toHaveLength(0)
  })

  it('audiência 0 → 200 recipients:0 sem criar broadcast nem consumir key', async () => {
    store.blueprint = blueprintFixture()
    store.audience = []
    const res = await call({ link_aula: 'x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, recipients: 0 })
    expect(store.idemInserts).toHaveLength(0)
    expect(store.broadcastInserts).toHaveLength(0)
  })
})

describe('idempotência', () => {
  it('23505 → 200 duplicate:true sem clone', async () => {
    store.blueprint = blueprintFixture()
    store.audience = [{ id: 'c1' }]
    store.idemInsertError = { code: '23505' }
    const res = await call({ link_aula: 'x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, duplicate: true })
    expect(store.broadcastInserts).toHaveLength(0)
  })
})

describe('happy path (H1: draft → recipients → sending)', () => {
  it('202 com clone draft, recipients em lote e flip pra sending na ordem certa', async () => {
    store.blueprint = blueprintFixture()
    store.audience = [{ id: 'c1' }, { id: 'c2' }]
    const res = await call({ link_aula: 'https://aula.com/live' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toEqual({ ok: true, broadcast_id: 'clone-1', recipients: 2 })

    // ordem dos efeitos prova o H1
    expect(store.ops).toEqual([
      'idem-insert',
      'insert-broadcast:draft',
      'insert-recipients:2',
      'update-broadcast:sending',
    ])

    // clone: variáveis materializadas (payload→static) + rastreio do blueprint
    const clone = store.broadcastInserts[0]
    expect(clone.source_blueprint_id).toBe('bp-1')
    expect(clone.template_variables).toEqual({
      '1': { type: 'static', value: 'https://aula.com/live' },
      '2': { type: 'field', value: 'name' },
    })
    expect(clone.total_recipients).toBe(2)
  })
})

describe('falha pós-consumo (M1)', () => {
  it('erro no insert de recipients → clone failed + key liberada + 500', async () => {
    store.blueprint = blueprintFixture()
    store.audience = [{ id: 'c1' }]
    store.recipientInsertError = { message: 'boom' }
    const res = await call({ link_aula: 'x' })
    expect(res.status).toBe(500)
    // key liberada pro retry legítimo passar
    expect(store.idemDeletes).toBe(1)
    // clone parcial marcado como failed
    expect(store.broadcastUpdates.at(-1)?.payload).toEqual({ status: 'failed' })
  })
})

describe('rate limit por IP', () => {
  it('11ª chamada → 429, mesmo trocando o token (bucket por IP)', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7', 'x-idempotency-key': 'k' }
    for (let i = 0; i < 10; i++) {
      const res = await call({}, { headers, token: `bh_${i}` })
      expect(res.status).toBe(404) // blueprint null — mas consumiu o bucket
    }
    const blocked = await call({}, { headers, token: 'bh_outro' })
    expect(blocked.status).toBe(429)
  })
})
