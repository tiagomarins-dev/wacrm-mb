import { describe, expect, it, beforeEach, vi } from 'vitest'

// Holder do db ativo + mocks de boundary (sender, loop LLM, recheck humano).
const holder: { db: unknown } = { db: null }
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => holder.db }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })) }))
vi.mock('./llm', () => ({ runAgentLoop: vi.fn() }))
// Mantém o phoneAllowed REAL (a allowlist é exercitada de verdade); só
// mocka o recheck humano.
vi.mock('./dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatch')>()
  return { ...actual, humanRecentlyReplied: vi.fn(async () => false) }
})

import { runAiAgentForConversation } from './engine'
import { engineSendText } from '@/lib/automations/meta-send'
import { runAgentLoop } from './llm'
import { humanRecentlyReplied } from './dispatch'

// Fake db: `b` é thenable (await direto) E tem maybeSingle/update.
// limit() devolve b (serve p/ `.limit().maybeSingle()` e p/ `await .limit()`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(byTable: Record<string, any>) {
  const updates: { table: string; payload: unknown }[] = []
  const builder = (table: string) => {
    const op = { type: 'select' as 'select' | 'update', payload: null as unknown }
    const result = () => {
      if (op.type === 'update') {
        updates.push({ table, payload: op.payload })
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
      update: (p: unknown) => ((op.type = 'update'), (op.payload = p), b),
      maybeSingle: () => Promise.resolve(result()),
      then: (f: (v: unknown) => unknown) => Promise.resolve(result()).then(f),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: (t: string) => builder(t) } as any, updates }
}

const row = { id: 'p1', account_id: 'acc-1', connection_id: 'conn-1', conversation_id: 'conv-1', contact_id: 'ct-1' }

// Tabelas do cenário-base (agente ligado, 1 msg do cliente, catálogo vazio).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function baseTables(): Record<string, any> {
  return {
    ai_agent_config: { enabled: true, model: 'm', classifier_model: null, max_bot_turns: 8, persona_prompt: null, handoff_routing: null, allowed_phones: null },
    messages: [{ sender_type: 'customer', content_text: 'quero o intensivo', content_type: 'text' }],
    student_info: null,
    ai_courses: [],
    ai_support_articles: [],
    contacts: { phone: '+5521987868395' },
    whatsapp_config: { user_id: 'u1' },
  }
}

beforeEach(() => {
  holder.db = null
  vi.clearAllMocks()
  vi.mocked(humanRecentlyReplied).mockResolvedValue(false)
})

describe('runAiAgentForConversation', () => {
  it('agente desligado → não envia', async () => {
    const t = baseTables()
    t.ai_agent_config = { ...t.ai_agent_config, enabled: false }
    holder.db = makeDb(t).db
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('sem mensagens → não envia', async () => {
    const t = baseTables()
    t.messages = []
    holder.db = makeDb(t).db
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('caminho feliz → aplica guardrail e envia via engineSendText; grava ai_topic', async () => {
    const { db, updates } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'Você pode comprar agora', topic: 'vendas' })
    await runAiAgentForConversation(row)
    // guardrail trocou "comprar" → "garantir"
    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('Você pode garantir agora')
    // ai_topic gravado
    const upd = updates.find((u) => u.table === 'conversations')
    expect((upd?.payload as { ai_topic: string }).ai_topic).toBe('vendas')
  })

  it('humano assumiu no meio do turno → NÃO envia', async () => {
    holder.db = makeDb(baseTables()).db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: null })
    vi.mocked(humanRecentlyReplied).mockResolvedValue(true)
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('reply null (tool agiu, ex. transferir) → não envia texto', async () => {
    holder.db = makeDb(baseTables()).db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: null, topic: 'suporte' })
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('MODO TESTE: contato fora da allowlist → NÃO envia (defesa dupla)', async () => {
    const t = baseTables()
    t.ai_agent_config = { ...t.ai_agent_config, allowed_phones: ['21987868395'] }
    t.contacts = { phone: '+5511999990000' } // fora da lista
    holder.db = makeDb(t).db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: 'vendas' })
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })
})
