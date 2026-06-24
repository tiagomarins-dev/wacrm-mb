import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'

// Holder do db ativo + mocks server-only (importar a rota não toca rede).
const holder: { db: unknown } = { db: null }
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => holder.db }))
vi.mock('@/lib/ai-agent/engine', () => ({ runAiAgentForConversation: vi.fn(async () => undefined) }))

import { GET } from './route'
import { runAiAgentForConversation } from '@/lib/ai-agent/engine'

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/ai-agent/cron', { headers })
}

// Fake db: select->limit devolve `due`; update(claim)->maybeSingle devolve {id};
// delete->eq resolve. Captura deletes p/ asserir o ack.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(due: any[]) {
  const deletes: unknown[] = []
  const builder = () => {
    const op = { type: 'select' as 'select' | 'update' | 'delete', id: null as unknown }
    const result = () => {
      if (op.type === 'update') return { data: { id: 'claimed' }, error: null }
      if (op.type === 'delete') return { data: null, error: null }
      return { data: due, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => (c === 'id' && (op.id = v), b),
      lte: () => b,
      order: () => b,
      limit: () => Promise.resolve(result()),
      update: () => ((op.type = 'update'), b),
      delete: () => ((op.type = 'delete'), b),
      maybeSingle: () => Promise.resolve(result()),
      then: (f: (v: unknown) => unknown) => {
        if (op.type === 'delete') deletes.push(op.id)
        return Promise.resolve(result()).then(f)
      },
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: () => builder() } as any, deletes }
}

const original = process.env.AUTOMATION_CRON_SECRET
beforeEach(() => {
  holder.db = null
  vi.clearAllMocks()
})
afterEach(() => {
  process.env.AUTOMATION_CRON_SECRET = original
})

describe('GET /api/ai-agent/cron — auth', () => {
  it('503 quando o secret não está configurado', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect((await GET(req())).status).toBe(503)
  })
  it('401 sem header', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'sekret'
    expect((await GET(req())).status).toBe(401)
  })
  it('401 com header errado', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'sekret'
    expect((await GET(req({ 'x-cron-secret': 'wrong' }))).status).toBe(401)
  })
})

describe('GET /api/ai-agent/cron — drain', () => {
  beforeEach(() => (process.env.AUTOMATION_CRON_SECRET = 'sekret'))

  it('fila vazia → processed 0', async () => {
    holder.db = makeDb([]).db
    const res = await GET(req({ 'x-cron-secret': 'sekret' }))
    expect(await res.json()).toEqual({ processed: 0 })
    expect(runAiAgentForConversation).not.toHaveBeenCalled()
  })

  it('1 pendência → claim, roda o engine, dá ack (delete) e conta processed', async () => {
    const { db, deletes } = makeDb([
      { id: 'p1', account_id: 'a', connection_id: 'c', conversation_id: 'cv', contact_id: 'ct', attempts: 0 },
    ])
    holder.db = db
    const res = await GET(req({ 'x-cron-secret': 'sekret' }))
    expect(await res.json()).toEqual({ processed: 1 })
    expect(runAiAgentForConversation).toHaveBeenCalledTimes(1)
    expect(deletes).toContain('p1') // ack removeu a pendência
  })
})
