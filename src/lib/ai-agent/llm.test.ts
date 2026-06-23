import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// Mocka as tools (isola o loop do llm) e a criptografia.
vi.mock('./tools', () => ({
  buildToolDefs: () => [{ type: 'function', function: { name: 'get_curso' } }],
  execTool: vi.fn(async () => ({ output: { ok: true }, detectedTopic: 'vendas' })),
}))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (v: string) => `dec(${v})` }))

import { runAgentLoop, resolveOpenRouterKey, type AgentCtx } from './llm'
import { execTool } from './tools'

// db que devolve a row de integrations_config (chave criptografada).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(keyRow: any) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    maybeSingle: () => Promise.resolve({ data: keyRow, error: null }),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => b } as any
}

function ctx(db: unknown, over: Partial<AgentCtx> = {}): AgentCtx {
  return {
    db: db as never,
    accountId: 'acc-1', connectionId: 'c', conversationId: 'cv', contactId: 'ct',
    model: 'openai/gpt-4o-mini', classifierModel: null, maxTurns: 4,
    system: 'SYS', messages: [{ role: 'user', content: 'oi' }], handoffRouting: null,
    allowedTools: null,
    ...over,
  }
}

// Resposta canned do OpenRouter.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const reply = (message: any) => ({ ok: true, json: async () => ({ choices: [{ message }] }) })

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllGlobals())

describe('resolveOpenRouterKey', () => {
  it('decripta a chave da conta', async () => {
    expect(await resolveOpenRouterKey(makeDb({ openrouter_api_key: 'ENC' }), 'acc-1')).toBe('dec(ENC)')
  })
  it('sem chave → lança', async () => {
    await expect(resolveOpenRouterKey(makeDb({ openrouter_api_key: null }), 'acc-1')).rejects.toThrow(/key/i)
  })
})

describe('runAgentLoop', () => {
  it('resposta final (sem tool_calls) → devolve reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply({ content: 'Olá! Vamos garantir sua vaga?' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await runAgentLoop(ctx(makeDb({ openrouter_api_key: 'ENC' })))
    expect(r.reply).toBe('Olá! Vamos garantir sua vaga?')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // M2: o body manda provider.data_collection:'deny' e tools.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.provider.data_collection).toBe('deny')
    expect(body.tools).toHaveLength(1)
  })

  it('tool_call → executa, realimenta e retorna a resposta final + topic', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply({ tool_calls: [{ id: 't1', function: { name: 'get_curso', arguments: '{}' } }] }))
      .mockResolvedValueOnce(reply({ content: 'A condição atual é 12x.' }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await runAgentLoop(ctx(makeDb({ openrouter_api_key: 'ENC' })))
    expect(execTool).toHaveBeenCalledTimes(1)
    expect(r.reply).toBe('A condição atual é 12x.')
    expect(r.topic).toBe('vendas')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('estoura maxTurns (sempre tool_call) → reply null', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(reply({ tool_calls: [{ id: 't', function: { name: 'get_curso', arguments: '{}' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await runAgentLoop(ctx(makeDb({ openrouter_api_key: 'ENC' }), { maxTurns: 2 }))
    expect(r.reply).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('erro HTTP do OpenRouter → encerra sem reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    const r = await runAgentLoop(ctx(makeDb({ openrouter_api_key: 'ENC' })))
    expect(r.reply).toBeNull()
  })
})
