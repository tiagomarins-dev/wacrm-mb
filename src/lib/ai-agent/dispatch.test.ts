import { describe, expect, it, beforeEach, vi } from 'vitest'
import { AI_AGENT_USER_ID } from './constants'

// Holder do db ativo (a factory do vi.mock fecha sobre ele); trocado por teste.
const holder: { db: unknown } = { db: null }
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => holder.db }))

import { dispatchInboundToAiAgent, phoneAllowed } from './dispatch'

// Fake db por tabela + captura de upserts. Cadeias usadas: select/eq/maybeSingle/upsert.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(byTable: Record<string, any>) {
  const upserts: { table: string; payload: unknown }[] = []
  const builder = (table: string) => {
    const op = { type: 'select' as 'select' | 'upsert', payload: null as unknown }
    const result = () => {
      if (op.type === 'upsert') {
        upserts.push({ table, payload: op.payload })
        return { data: null, error: null }
      }
      return { data: byTable[table] ?? null, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      upsert: (p: unknown) => ((op.type = 'upsert'), (op.payload = p), Promise.resolve(result())),
      maybeSingle: () => Promise.resolve(result()),
      then: (f: (v: unknown) => unknown) => Promise.resolve(result()).then(f),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: (t: string) => builder(t) } as any, upserts }
}

const input = {
  accountId: 'acc-1',
  connectionId: 'conn-1',
  contactId: 'contact-1',
  conversationId: 'conv-1',
  inboundMessageId: 'wamid.1',
  flowConsumed: false,
}

// Cenário-base: agente ligado, conversa ATRIBUÍDA À IA, contato sem opt-out.
// Tipos frouxos p/ os testes poderem reatribuir cada tabela.
function happyTables(): {
  ai_agent_config: { enabled: boolean; debounce_seconds: number; allowed_phones?: string[] | null } | null
  conversations: { assigned_agent_id: string | null }
  contacts: { ai_opt_out: boolean; phone?: string | null }
} {
  return {
    ai_agent_config: { enabled: true, debounce_seconds: 10, allowed_phones: null },
    conversations: { assigned_agent_id: AI_AGENT_USER_ID },
    contacts: { ai_opt_out: false, phone: '+5521987868395' },
  }
}

beforeEach(() => (holder.db = null))

describe('dispatchInboundToAiAgent', () => {
  it('flowConsumed → não enfileira', async () => {
    const { db, upserts } = makeDb(happyTables())
    holder.db = db
    await dispatchInboundToAiAgent({ ...input, flowConsumed: true })
    expect(upserts).toHaveLength(0)
  })

  it('agente desligado → não enfileira', async () => {
    const t = happyTables()
    t.ai_agent_config = { enabled: false, debounce_seconds: 10 }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })

  it('sem config → não enfileira', async () => {
    const t = happyTables()
    t.ai_agent_config = null
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })

  it('conversa NÃO atribuída à IA → não enfileira', async () => {
    const t = happyTables()
    t.conversations = { assigned_agent_id: 'humano-123' }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })

  it('conversa sem responsável (null) → não enfileira', async () => {
    const t = happyTables()
    t.conversations = { assigned_agent_id: null }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })

  it('contato opt-out → não enfileira', async () => {
    const t = happyTables()
    t.contacts = { ai_opt_out: true }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })

  it('atribuída à IA + tudo ok → upsert pending com run_at futuro', async () => {
    const { db, upserts } = makeDb(happyTables())
    holder.db = db
    const before = Date.now()
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(1)
    const p = upserts[0].payload as { status: string; run_at: string; conversation_id: string }
    expect(p.status).toBe('pending')
    expect(p.conversation_id).toBe('conv-1')
    expect(new Date(p.run_at).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('allowlist opcional: fora da lista → não enfileira (mesmo atribuída à IA)', async () => {
    const t = happyTables()
    t.ai_agent_config = { enabled: true, debounce_seconds: 10, allowed_phones: ['21987868395'] }
    t.contacts = { ai_opt_out: false, phone: '+5511999990000' }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })
})

describe('phoneAllowed', () => {
  it('lista vazia/null → permite todos', () => {
    expect(phoneAllowed('+5521987868395', null)).toBe(true)
    expect(phoneAllowed('+5521987868395', [])).toBe(true)
  })
  it('casa por sufixo (tolera prefixo 55) e por igualdade', () => {
    expect(phoneAllowed('+5521987868395', ['21987868395'])).toBe(true)
    expect(phoneAllowed('5521987868395', ['5521987868395'])).toBe(true)
    expect(phoneAllowed('(21) 98786-8395', ['21987868395'])).toBe(true)
  })
  it('número diferente → bloqueia', () => {
    expect(phoneAllowed('+5511999990000', ['21987868395'])).toBe(false)
  })
  it('telefone vazio com lista → bloqueia', () => {
    expect(phoneAllowed(null, ['21987868395'])).toBe(false)
    expect(phoneAllowed('', ['21987868395'])).toBe(false)
  })
})
