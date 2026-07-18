// ============================================================
// Testa a rota pública POST /api/automations/webhook/[token] por
// invocação direta. Mocka admin client + inbound (contato/conversa) +
// engine (dispatch). Rate limit é o módulo REAL (com reset por teste)
// pra provar o bucket por IP (anti-enumeração).
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  automation: null as Record<string, unknown> | null,
  customFields: [] as { id: string; field_name: string }[],
  idemInsertError: null as { code: string } | null,
  idemInserts: [] as Record<string, unknown>[],
  contactUpdates: [] as Record<string, unknown>[],
  upserts: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === 'automations') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: store.automation, error: null }),
        }
        return b
      }
      if (table === 'custom_fields') {
        return {
          select: () => ({
            eq: async () => ({ data: store.customFields, error: null }),
          }),
        }
      }
      if (table === 'automation_webhook_events') {
        return {
          insert: async (row: Record<string, unknown>) => {
            store.idemInserts.push(row)
            return { error: store.idemInsertError }
          },
        }
      }
      if (table === 'contacts') {
        return {
          update: (row: Record<string, unknown>) => ({
            eq: async () => {
              store.contactUpdates.push(row)
              return { error: null }
            },
          }),
        }
      }
      if (table === 'contact_custom_values') {
        return {
          upsert: async (row: Record<string, unknown>) => {
            store.upserts.push(row)
            return { error: null }
          },
        }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/automations/engine', () => ({
  runSingleAutomation: vi.fn(async () => {}),
}))

vi.mock('@/lib/whatsapp/inbound', () => ({
  findOrCreateContact: vi.fn(async () => ({
    contact: { id: 'c1', name: 'Antigo' },
    wasCreated: false,
  })),
  findOrCreateConversation: vi.fn(async () => ({ id: 'conv1' })),
}))

import { POST } from './route'
import { runSingleAutomation } from '@/lib/automations/engine'
import {
  findOrCreateContact,
  findOrCreateConversation,
} from '@/lib/whatsapp/inbound'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const TOKEN = 'wh_' + 'a'.repeat(32)

function automationFixture() {
  return {
    id: 'a1',
    account_id: 'acct-1',
    user_id: 'u1',
    connection_id: 'conn-1',
    trigger_type: 'webhook_received',
    trigger_config: {},
    is_active: true,
    webhook_token: TOKEN,
  }
}

function call(
  body: unknown,
  opts: { token?: string; headers?: Record<string, string> } = {},
) {
  const req = new Request('http://localhost/api/automations/webhook/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return POST(req, { params: Promise.resolve({ token: opts.token ?? TOKEN }) })
}

beforeEach(() => {
  __resetRateLimitForTests()
  store.automation = null
  store.customFields = []
  store.idemInsertError = null
  store.idemInserts = []
  store.contactUpdates = []
  store.upserts = []
  vi.mocked(runSingleAutomation).mockClear()
  vi.mocked(findOrCreateContact).mockClear()
  vi.mocked(findOrCreateConversation).mockClear()
})

describe('validação de payload', () => {
  it('400 quando phone falta', async () => {
    const res = await call({ name: 'Maria' })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('phone')
  })

  it('400 quando phone tem máscara/formato inválido', async () => {
    for (const phone of ['+55 (21) 99999-8888', '21999998888x', '123456789']) {
      const res = await call({ phone })
      expect(res.status).toBe(400)
    }
  })

  it('413 quando o body passa de 32KB', async () => {
    const res = await call({ phone: '5521999998888', blob: 'x'.repeat(33 * 1024) })
    expect(res.status).toBe(413)
  })

  it('400 quando o body não é objeto JSON', async () => {
    expect((await call('[]')).status).toBe(400)
    expect((await call('not-json')).status).toBe(400)
  })

  it('400 quando X-Idempotency-Key passa de 200 chars', async () => {
    const res = await call(
      { phone: '5521999998888' },
      { headers: { 'x-idempotency-key': 'k'.repeat(201) } },
    )
    expect(res.status).toBe(400)
  })

  it('400 quando email é inválido', async () => {
    const res = await call({ phone: '5521999998888', email: 'não-é-email' })
    expect(res.status).toBe(400)
  })
})

describe('resolução da automação', () => {
  it('404 genérico para token desconhecido/automação inativa', async () => {
    store.automation = null
    const res = await call({ phone: '5521999998888' })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Not found')
  })

  it('404 quando a automação não tem conexão', async () => {
    store.automation = { ...automationFixture(), connection_id: null }
    const res = await call({ phone: '5521999998888' })
    expect(res.status).toBe(404)
  })
})

describe('campos customizados', () => {
  it('400 com invalid_fields para chave não cadastrada', async () => {
    store.automation = automationFixture()
    store.customFields = [{ id: 'cf1', field_name: 'curso' }]
    const res = await call({ phone: '5521999998888', curso: 'Medicina', typo: 'x' })
    expect(res.status).toBe(400)
    expect((await res.json()).invalid_fields).toEqual(['typo'])
    expect(vi.mocked(runSingleAutomation)).not.toHaveBeenCalled()
  })

  it('400 para valor não-primitivo', async () => {
    store.automation = automationFixture()
    store.customFields = [{ id: 'cf1', field_name: 'curso' }]
    const res = await call({ phone: '5521999998888', curso: { nested: true } })
    expect(res.status).toBe(400)
    expect((await res.json()).invalid_fields).toEqual(['curso'])
  })
})

describe('idempotência', () => {
  it('200 duplicate:true sem dispatch quando a key repete (23505)', async () => {
    store.automation = automationFixture()
    store.idemInsertError = { code: '23505' }
    const res = await call(
      { phone: '5521999998888' },
      { headers: { 'x-idempotency-key': 'matricula-1' } },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, duplicate: true })
    expect(vi.mocked(runSingleAutomation)).not.toHaveBeenCalled()
  })

  it('sem header executa sempre (não grava evento)', async () => {
    store.automation = automationFixture()
    const res = await call({ phone: '5521999998888' })
    expect(res.status).toBe(202)
    expect(store.idemInserts).toHaveLength(0)
  })
})

describe('happy path', () => {
  it('202 + contato/conversa/custom/dispatch com vars = payload', async () => {
    store.automation = automationFixture()
    store.customFields = [{ id: 'cf1', field_name: 'curso' }]
    const payload = {
      phone: '5521999998888',
      name: 'Maria Nova',
      email: 'maria@ex.com',
      curso: 'Medicina UERJ',
    }
    const res = await call(payload, {
      headers: { 'x-idempotency-key': 'matricula-2' },
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true })

    // contato resolvido na conexão da automação
    expect(vi.mocked(findOrCreateContact)).toHaveBeenCalledWith(
      expect.anything(), 'acct-1', 'u1', 'conn-1', '5521999998888', 'Maria Nova',
    )
    // name/email sobrescrevem sempre
    expect(store.contactUpdates).toHaveLength(1)
    expect(store.contactUpdates[0]).toMatchObject({
      name: 'Maria Nova',
      email: 'maria@ex.com',
    })
    // custom value upsertado
    expect(store.upserts).toEqual([
      { contact_id: 'c1', custom_field_id: 'cf1', value: 'Medicina UERJ' },
    ])
    // conversa na conexão da automação
    expect(vi.mocked(findOrCreateConversation)).toHaveBeenCalledWith(
      expect.anything(), 'acct-1', 'u1', 'conn-1', 'c1',
    )
    // dispatch com o payload inteiro em vars
    expect(vi.mocked(runSingleAutomation)).toHaveBeenCalledTimes(1)
    const [auto, input] = vi.mocked(runSingleAutomation).mock.calls[0]
    expect((auto as { id: string }).id).toBe('a1')
    expect(input).toMatchObject({
      accountId: 'acct-1',
      connectionId: 'conn-1',
      triggerType: 'webhook_received',
      contactId: 'c1',
      context: { conversation_id: 'conv1', vars: payload },
    })
  })
})

describe('rate limit por IP (anti-enumeração)', () => {
  it('429 na 61ª chamada — mesmo trocando o token (bucket é por IP)', async () => {
    store.automation = null // 404s também consomem o bucket
    const headers = { 'x-forwarded-for': '203.0.113.9' }
    for (let i = 0; i < 60; i++) {
      const res = await call({ phone: '5521999998888' }, { headers, token: `wh_${i}` })
      expect(res.status).toBe(404)
    }
    const blocked = await call({ phone: '5521999998888' }, { headers, token: 'wh_outro' })
    expect(blocked.status).toBe(429)
  })
})
