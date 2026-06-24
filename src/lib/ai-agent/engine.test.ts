import { describe, expect, it, beforeEach, vi } from 'vitest'

// Holder do db ativo + mocks de boundary (sender, loop LLM, gate de atribuição).
const holder: { db: unknown } = { db: null }
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => holder.db }))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })) }))
vi.mock('./llm', () => ({ runAgentLoop: vi.fn() }))
// Mantém o phoneAllowed REAL; mocka resolveAssignedProfile (perfil responsável).
vi.mock('./dispatch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./dispatch')>()
  return { ...actual, resolveAssignedProfile: vi.fn() }
})

import { runAiAgentForConversation, splitIntoMessages, extractStudentCourses } from './engine'
import { engineSendText } from '@/lib/automations/meta-send'
import { runAgentLoop } from './llm'
import { resolveAssignedProfile } from './dispatch'

// Perfil de IA mockado (campos que o engine lê).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PROFILE: any = {
  id: 'profile-1', account_id: 'acc-1', nome: 'Assistente', enabled: true,
  persona_prompt: null, model: 'm', classifier_model: null, max_bot_turns: 8,
  handoff_routing: null, allowed_tools: null,
}

// Fake db: `b` é thenable (await direto) E tem maybeSingle/update.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(byTable: Record<string, any>, opts: { insertThrows?: boolean } = {}) {
  const updates: { table: string; payload: unknown }[] = []
  const inserts: { table: string; payload: unknown }[] = []
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
      // insert é terminal (recordAgentRun faz `await ...insert(run)`). `insertThrows`
      // simula tabela ausente/boundary p/ provar que a gravação é best-effort.
      insert: (p: unknown) => {
        if (opts.insertThrows) throw new Error('relation "ai_agent_runs" does not exist')
        inserts.push({ table, payload: p })
        return { data: null, error: null }
      },
      maybeSingle: () => Promise.resolve(result()),
      then: (f: (v: unknown) => unknown) => Promise.resolve(result()).then(f),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: (t: string) => builder(t) } as any, updates, inserts }
}

// Telemetria canned p/ os mocks de runAgentLoop (observabilidade).
const TEL = {
  requests: 1, turns: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15,
  costUsd: 0.0003, llmMs: 120, finishReason: 'stop', toolsUsed: [] as string[], error: null,
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
  // Default: a conversa é do PROFILE no load e no recheck.
  vi.mocked(resolveAssignedProfile).mockResolvedValue(PROFILE)
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
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'Você pode comprar agora', topic: 'vendas', handoff: null, telemetry: TEL })
    await runAiAgentForConversation(row)
    expect(engineSendText).toHaveBeenCalledTimes(1)
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('Você pode garantir agora')
    const upd = updates.find((u) => u.table === 'conversations')
    expect((upd?.payload as { ai_topic: string }).ai_topic).toBe('vendas')
  })

  it('reatribuíram no meio do turno (perfil mudou/humano assumiu) → NÃO envia (M1)', async () => {
    holder.db = makeDb(baseTables()).db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: null, handoff: null, telemetry: TEL })
    // load = PROFILE; recheck = null (não é mais o mesmo perfil) → aborta.
    vi.mocked(resolveAssignedProfile).mockReset()
    vi.mocked(resolveAssignedProfile).mockResolvedValueOnce(PROFILE).mockResolvedValueOnce(null)
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
      telemetry: TEL,
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
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: null, topic: 'suporte', handoff: null, telemetry: TEL })
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
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: 'vendas', handoff: null, telemetry: TEL })
    await runAiAgentForConversation(row)
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('resposta com 2 parágrafos → envia 2 bolhas separadas', async () => {
    holder.db = makeDb(baseTables()).db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'Oi Tiago.\n\nVamos garantir sua vaga?', topic: 'vendas', handoff: null, telemetry: TEL })
    await runAiAgentForConversation(row)
    expect(engineSendText).toHaveBeenCalledTimes(2)
    expect(vi.mocked(engineSendText).mock.calls[0][0].text).toBe('Oi Tiago.')
    expect(vi.mocked(engineSendText).mock.calls[1][0].text).toBe('Vamos garantir sua vaga?')
  })

  // ----- Observabilidade (ai_agent_runs) -----

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const runRow = (inserts: { table: string; payload: unknown }[]): any =>
    inserts.find((i) => i.table === 'ai_agent_runs')?.payload

  it('grava run ok com telemetria (custo/latência/status)', async () => {
    const { db, inserts } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: 'vendas', handoff: null, telemetry: TEL })
    await runAiAgentForConversation(row)
    const run = runRow(inserts)
    expect(run.status).toBe('ok')
    expect(run.cost_usd).toBe(0.0003)
    expect(typeof run.latency_ms).toBe('number')
    expect(run.requests).toBe(1)
  })

  it('allowlist bloqueou → run status=blocked', async () => {
    const t = baseTables()
    t.ai_agent_config = { ...t.ai_agent_config, allowed_phones: ['21987868395'] }
    t.contacts = { phone: '+5511999990000' }
    const { db, inserts } = makeDb(t)
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: 'vendas', handoff: null, telemetry: TEL })
    await runAiAgentForConversation(row)
    expect(runRow(inserts).status).toBe('blocked')
  })

  it('reply null → run status=no_reply', async () => {
    const { db, inserts } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: null, topic: 'suporte', handoff: null, telemetry: TEL })
    await runAiAgentForConversation(row)
    expect(runRow(inserts).status).toBe('no_reply')
  })

  it('reatribuíram (superseded) → grava run status=superseded', async () => {
    const { db, inserts } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: null, handoff: null, telemetry: TEL })
    vi.mocked(resolveAssignedProfile).mockReset()
    vi.mocked(resolveAssignedProfile).mockResolvedValueOnce(PROFILE).mockResolvedValueOnce(null)
    await runAiAgentForConversation(row)
    expect(runRow(inserts).status).toBe('superseded')
  })

  it('erro do loop LLM (telemetry.error) → run status=error, error_phase=llm', async () => {
    const { db, inserts } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({
      reply: null, topic: null, handoff: null,
      telemetry: { ...TEL, error: { phase: 'llm', message: 'OpenRouter 500' } },
    })
    await runAiAgentForConversation(row)
    const run = runRow(inserts)
    expect(run.status).toBe('error')
    expect(run.error_phase).toBe('llm')
    expect(run.error_message).toBe('OpenRouter 500')
  })

  it('guardrail: reply com termo proibido → guardrail_hits=1 (mesmo enviando)', async () => {
    const { db, inserts } = makeDb(baseTables())
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'Você pode comprar agora', topic: 'vendas', handoff: null, telemetry: TEL })
    await runAiAgentForConversation(row)
    expect(runRow(inserts).guardrail_hits).toBe(1)
  })

  it('gravação best-effort: insert lança → NÃO impede o envio nem propaga', async () => {
    const { db } = makeDb(baseTables(), { insertThrows: true })
    holder.db = db
    vi.mocked(runAgentLoop).mockResolvedValue({ reply: 'oi', topic: 'vendas', handoff: null, telemetry: TEL })
    await expect(runAiAgentForConversation(row)).resolves.toBeUndefined()
    expect(engineSendText).toHaveBeenCalledTimes(1)
  })
})

describe('extractStudentCourses', () => {
  it('extrai nome_curso do payload', () => {
    const student = { payload: { cursos_matriculados: [{ nome_curso: 'Mestres da UERJ' }, { nome_curso: 'Gramática' }] } }
    expect(extractStudentCourses(student)).toEqual(['Mestres da UERJ', 'Gramática'])
  })
  it('não aluno / payload sem cursos → []', () => {
    expect(extractStudentCourses(null)).toEqual([])
    expect(extractStudentCourses({ payload: { aluno: {} } })).toEqual([])
  })
})

describe('splitIntoMessages', () => {
  it('quebra por linha em branco (parágrafos)', () => {
    expect(splitIntoMessages('a\n\nb\n\nc')).toEqual(['a', 'b', 'c'])
  })
  it('parágrafo único → 1 bolha', () => {
    expect(splitIntoMessages('uma frase só')).toEqual(['uma frase só'])
  })
  it('junta excedente além de 6 bolhas na última', () => {
    const r = splitIntoMessages('1\n\n2\n\n3\n\n4\n\n5\n\n6\n\n7\n\n8')
    expect(r).toHaveLength(6)
    expect(r[5]).toBe('6\n\n7\n\n8')
  })
})
