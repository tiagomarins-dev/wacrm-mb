import { describe, expect, it, beforeEach, vi } from 'vitest'

// Holder do db ativo (a factory do vi.mock fecha sobre ele); trocado por teste.
const holder: { db: unknown } = { db: null }
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => holder.db }))

import { dispatchInboundToAiAgent, phoneAllowed } from './dispatch'

// Fake db por tabela + captura de upserts. Suporta as cadeias usadas:
// select/eq/in/order/limit/maybeSingle/upsert.
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
      in: () => b,
      order: () => b,
      limit: () => b,
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

// Cenário-base: agente ligado, contato sem opt-out, último msg do bot (não humano).
// Tipos frouxos p/ os testes poderem reatribuir cada tabela.
function happyTables(): {
  ai_agent_config: { enabled: boolean; debounce_seconds: number; allowed_phones?: string[] | null } | null
  contacts: { ai_opt_out: boolean; phone?: string | null }
  messages: { sender_type: string; created_at?: string }
} {
  return {
    ai_agent_config: { enabled: true, debounce_seconds: 10, allowed_phones: null },
    contacts: { ai_opt_out: false, phone: '+5521987868395' },
    messages: { sender_type: 'bot' },
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
    t.ai_agent_config = null // simulando ausência de config
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

  it('humano respondeu RECENTEMENTE (dentro da janela) → não enfileira', async () => {
    const t = happyTables()
    t.messages = { sender_type: 'agent', created_at: new Date().toISOString() }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })

  it('humano respondeu HÁ MUITO (fora da janela) → reengaja (enfileira)', async () => {
    const t = happyTables()
    // 8h atrás — fora da janela de 30 min.
    t.messages = { sender_type: 'agent', created_at: new Date(Date.now() - 8 * 3600_000).toISOString() }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(1)
  })

  it('caminho feliz → upsert com status pending e run_at futuro', async () => {
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

  it('MODO TESTE: contato FORA da allowlist → não enfileira', async () => {
    const t = happyTables()
    t.ai_agent_config = { enabled: true, debounce_seconds: 10, allowed_phones: ['21987868395'] }
    t.contacts = { ai_opt_out: false, phone: '+5511999990000' } // outro número
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(0)
  })

  it('MODO TESTE: contato NA allowlist → enfileira', async () => {
    const t = happyTables()
    t.ai_agent_config = { enabled: true, debounce_seconds: 10, allowed_phones: ['21987868395'] }
    t.contacts = { ai_opt_out: false, phone: '+5521987868395' }
    const { db, upserts } = makeDb(t)
    holder.db = db
    await dispatchInboundToAiAgent(input)
    expect(upserts).toHaveLength(1)
  })
})

describe('phoneAllowed', () => {
  it('lista vazia/null → permite todos', () => {
    expect(phoneAllowed('+5521987868395', null)).toBe(true)
    expect(phoneAllowed('+5521987868395', [])).toBe(true)
  })
  it('casa por sufixo (tolera prefixo 55) e por igualdade', () => {
    expect(phoneAllowed('+5521987868395', ['21987868395'])).toBe(true) // sufixo
    expect(phoneAllowed('5521987868395', ['5521987868395'])).toBe(true) // igualdade
    expect(phoneAllowed('(21) 98786-8395', ['21987868395'])).toBe(true) // normaliza dígitos
  })
  it('número diferente → bloqueia', () => {
    expect(phoneAllowed('+5511999990000', ['21987868395'])).toBe(false)
  })
  it('telefone vazio com lista → bloqueia', () => {
    expect(phoneAllowed(null, ['21987868395'])).toBe(false)
    expect(phoneAllowed('', ['21987868395'])).toBe(false)
  })
})
