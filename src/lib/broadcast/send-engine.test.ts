import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mocks das dependências do engine — isolam o drain da rede/Meta/Supabase.
vi.mock('./send-batch', () => ({ sendRecipients: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s }))
vi.mock('@/lib/whatsapp/template-row-guard', () => ({ isMessageTemplate: () => true }))
vi.mock('./variables', () => ({
  resolveVariables: () => ['v'],
  fetchCustomValueIndex: async () => new Map(),
}))

import { drainBroadcast, type ScheduledBroadcastRow } from './send-engine'
import { sendRecipients } from './send-batch'

const mockedSend = vi.mocked(sendRecipients)

interface Store {
  config: { phone_number_id: string; access_token: string } | null
  pending: Array<{ id: string; contact: { id: string; phone?: string } | null }>
  template: Record<string, unknown> | null
  remaining: number
  sentCount: number
  recipientUpdates: Array<{ in?: unknown; payload: Record<string, unknown> }>
  broadcastUpdates: Array<Record<string, unknown>>
}

// Fake do SupabaseClient: chainable + thenable, resolve por tabela/op.
function makeAdmin(store: Store) {
  function resolve(table: string, state: {
    op: string
    opts?: { count?: string }
    payload?: Record<string, unknown>
    inVal?: unknown
  }) {
    if (state.op === 'update') {
      if (table === 'broadcasts') store.broadcastUpdates.push(state.payload ?? {})
      else if (table === 'broadcast_recipients')
        store.recipientUpdates.push({ in: state.inVal, payload: state.payload ?? {} })
      return { error: null }
    }
    if (table === 'whatsapp_config') return { data: store.config, error: null }
    if (table === 'message_templates') return { data: store.template, error: null }
    if (table === 'broadcasts')
      return { data: { sent_count: store.sentCount }, error: null }
    if (table === 'broadcast_recipients') {
      if (state.opts?.count) return { count: store.remaining, error: null }
      return { data: store.pending, error: null }
    }
    return { data: null, error: null }
  }

  function from(table: string) {
    const state: {
      op: string
      opts?: { count?: string }
      payload?: Record<string, unknown>
      inVal?: unknown
    } = { op: 'select' }
    const run = () => Promise.resolve(resolve(table, state))
    const chain = {
      select: (_s: string, opts?: { count?: string }) => {
        state.op = 'select'
        state.opts = opts
        return chain
      },
      update: (payload: Record<string, unknown>) => {
        state.op = 'update'
        state.payload = payload
        return chain
      },
      delete: () => {
        state.op = 'delete'
        return chain
      },
      eq: () => chain,
      in: (_k: string, v: unknown) => {
        state.inVal = v
        return chain
      },
      lte: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => run(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (onF: any, onR: any) => run().then(onF, onR),
    }
    return chain
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from } as any
}

const broadcast: ScheduledBroadcastRow = {
  id: 'b1',
  account_id: 'a1',
  connection_id: null,
  template_name: 'promo',
  template_language: 'en_US',
  template_variables: {},
}

beforeEach(() => {
  mockedSend.mockReset()
})

describe('drainBroadcast', () => {
  it('envia pendentes e finaliza como sent', async () => {
    const store: Store = {
      config: { phone_number_id: 'PN', access_token: 'enc' },
      pending: [{ id: 'r1', contact: { id: 'c1', phone: '5521999' } }],
      template: {},
      remaining: 0,
      sentCount: 1,
      recipientUpdates: [],
      broadcastUpdates: [],
    }
    mockedSend.mockResolvedValue({
      results: [{ phone: '5521999', status: 'sent', whatsapp_message_id: 'wamid1' }],
      sentCount: 1,
      failedCount: 0,
    })

    const res = await drainBroadcast(makeAdmin(store), broadcast, 50)

    expect(res.sent).toBe(1)
    expect(res.hasMore).toBe(false)
    expect(res.finalized).toBe(true)
    expect(store.recipientUpdates.some((u) => u.payload.status === 'sent')).toBe(true)
    expect(store.broadcastUpdates.at(-1)?.status).toBe('sent')
  })

  it('sem whatsapp_config: marca recipients e broadcast como failed', async () => {
    const store: Store = {
      config: null,
      pending: [{ id: 'r1', contact: { id: 'c1', phone: '5521999' } }],
      template: null,
      remaining: 0,
      sentCount: 0,
      recipientUpdates: [],
      broadcastUpdates: [],
    }

    const res = await drainBroadcast(makeAdmin(store), broadcast, 50)

    expect(res.failed).toBe(1)
    expect(res.finalized).toBe(true)
    expect(mockedSend).not.toHaveBeenCalled()
    expect(store.broadcastUpdates.at(-1)?.status).toBe('failed')
  })

  it('recipient sem telefone falha sem chamar o envio', async () => {
    const store: Store = {
      config: { phone_number_id: 'PN', access_token: 'enc' },
      pending: [{ id: 'r1', contact: { id: 'c1' } }],
      template: {},
      remaining: 0,
      sentCount: 0,
      recipientUpdates: [],
      broadcastUpdates: [],
    }

    const res = await drainBroadcast(makeAdmin(store), broadcast, 50)

    expect(res.failed).toBe(1)
    expect(mockedSend).not.toHaveBeenCalled()
    expect(store.recipientUpdates[0]?.payload.error_message).toBe(
      'No phone number on contact',
    )
  })

  it('idempotência: lote vazio finaliza sem reenviar', async () => {
    const store: Store = {
      config: { phone_number_id: 'PN', access_token: 'enc' },
      pending: [],
      template: {},
      remaining: 0,
      sentCount: 2,
      recipientUpdates: [],
      broadcastUpdates: [],
    }

    const res = await drainBroadcast(makeAdmin(store), broadcast, 50)

    expect(res.sent).toBe(0)
    expect(res.failed).toBe(0)
    expect(mockedSend).not.toHaveBeenCalled()
    expect(store.broadcastUpdates.at(-1)?.status).toBe('sent')
  })

  it('mais pendentes restantes: não finaliza (hasMore)', async () => {
    const store: Store = {
      config: { phone_number_id: 'PN', access_token: 'enc' },
      pending: [{ id: 'r1', contact: { id: 'c1', phone: '5521999' } }],
      template: {},
      remaining: 5, // ainda há pendentes após este lote
      sentCount: 1,
      recipientUpdates: [],
      broadcastUpdates: [],
    }
    mockedSend.mockResolvedValue({
      results: [{ phone: '5521999', status: 'sent', whatsapp_message_id: 'w' }],
      sentCount: 1,
      failedCount: 0,
    })

    const res = await drainBroadcast(makeAdmin(store), broadcast, 1)

    expect(res.hasMore).toBe(true)
    expect(res.finalized).toBe(false)
    // não deve ter atualizado o status do broadcast (não finalizou)
    expect(store.broadcastUpdates).toHaveLength(0)
  })
})
