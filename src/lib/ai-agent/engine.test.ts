import { describe, expect, it, beforeEach, vi } from 'vitest'

// Holder do db ativo + mocks de boundary (sender, loop LLM, gate de atribuição).
const holder: { db: unknown } = { db: null }
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => holder.db }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })) }))
vi.mock('./llm', () => ({ runAgentLoop: vi.fn() }))
// Mantém o phoneAllowed REAL; só mocka o recheck de atribuição (isAssignedToAi).
vi.mock('./dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatch')>()
  return { ...actual, isAssignedToAi: vi.fn(async () => true) }
})

import { runAiAgentForConversation } from './engine'
import { engineSendText } from '@/lib/automations/meta-send'
import { runAgentLoop } from './llm'
import { isAssignedToAi } from './dispatch'

// Fake db: `b` é thenable (await direto) E tem maybeSingle/update.
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
  vi.mocked(isAssignedToAi).mockResolvedValue(true)
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
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'Você pode comprar agora', topic: 'vendas', handoff: null })
    await runAiAgentForConversation(row)
    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('Você pode garantir agora')
    const upd = updates.find((u) => u.table === 'conversations')
    expect((upd?.payload as { ai_topic: string }).ai_topic).toBe('vendas')
  })

  it('humano reatribuiu no meio do turno (não é mais da IA) → NÃO envia', async () => {
    holder.db = makeDb(baseTables()).db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: null, handoff: null })
    vi.mocked(isAssignedToAi).mockResolvedValue(false)
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('transferir_humano: envia a msg de despedida E reatribui ao humano (handoff pós-envio)', async () => {
    const { db, updates } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({
      reply: 'Vou te transferir para um atendente. Um momento!',
      topic: 'suporte',
      handoff: { to: 'humano-9' },
    })
    await runAiAgentForConversation(row)
    // mandou a despedida (a IA ainda era responsável no recheck)
    expect(engineSendText).toHaveBeenCalledTimes(1)
    // e reatribuiu a conversa ao humano roteado
    const reassign = updates.find(
      (u) => u.table === 'conversations' && (u.payload as { assigned_agent_id?: string }).assigned_agent_id !== undefined,
    )
    expect((reassign?.payload as { assigned_agent_id: string }).assigned_agent_id).toBe('humano-9')
  })

  it('reply null sem handoff → não envia nem reatribui', async () => {
    const { db, updates } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: null, topic: 'suporte', handoff: null })
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
    const reassign = updates.find(
      (u) => u.table === 'conversations' && (u.payload as { assigned_agent_id?: string }).assigned_agent_id !== undefined,
    )
    expect(reassign).toBeUndefined()
  })

  it('allowlist opcional: contato fora da lista → NÃO envia', async () => {
    const t = baseTables()
    t.ai_agent_config = { ...t.ai_agent_config, allowed_phones: ['21987868395'] }
    t.contacts = { phone: '+5511999990000' }
    holder.db = makeDb(t).db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: 'vendas', handoff: null })
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })
})
