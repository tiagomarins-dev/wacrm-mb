import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '@/test/msw/server'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { encrypt } from '@/lib/whatsapp/encryption'

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn() }))

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { POST } from './route'

const SENHA = 'senha-de-teste-playground-24ch'
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions'

function req(body: unknown) {
  return new Request('http://localhost/api/playground-ruth/chat', {
    method: 'POST',
    headers: { 'x-playground-password': SENHA, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const PROFILE = {
  id: 'p1',
  account_id: 'acc-1',
  nome: 'Ruth',
  slug: 'ruth',
  enabled: true,
  persona_prompt: 'PERSONA-DO-BANCO',
  opening_prompt: null,
  model: 'anthropic/claude-sonnet-4.6',
  classifier_model: null,
  max_bot_turns: 8,
  handoff_routing: { vendas: 'agent-7' },
  allowed_tools: null,
}

// db fake por tabela, com captura de TODA escrita (insert/update) e das
// tabelas lidas — é a prova do zero-write do playground.
function makeDb(overrides: Record<string, unknown> = {}) {
  const writes: { table: string; op: string }[] = []
  const openrouterKey = encrypt('sk-or-test')
  const canned: Record<string, unknown> = {
    ai_profiles: [{ account_id: 'acc-1' }], // caminho do resolvePlaygroundAccountId
    ai_profiles__single: PROFILE, //  caminho do maybeSingle (perfil)
    integrations_config: { openrouter_api_key: openrouterKey },
    ai_courses: [],
    ai_support_articles: [],
    contacts: { name: 'Fulana', email: null },
    student_info: null,
    broadcast_recipients: [{ lead_context: { objetivo: 'medicina' } }],
    ...overrides,
  }
  const from = (table: string) => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      not: () => b,
      order: () => b,
      like: () => b,
      insert: () => (writes.push({ table, op: 'insert' }), Promise.resolve({ data: null, error: null })),
      update: () => (writes.push({ table, op: 'update' }), b),
      maybeSingle: () =>
        Promise.resolve({
          data: canned[`${table}__single`] ?? canned[table] ?? null,
          error: null,
        }),
      limit: () => Promise.resolve({ data: canned[table] ?? [], error: null }),
      then: (f: (v: unknown) => unknown) =>
        Promise.resolve({ data: canned[table] ?? [], error: null }).then(f),
    }
    return b
  }
  return { db: { from } as never, writes }
}

// Handler MSW do OpenRouter que captura o body e devolve uma resposta simples.
function mockOpenRouter(reply: string) {
  const bodies: Record<string, unknown>[] = []
  server.use(
    http.post(OPENROUTER, async ({ request }) => {
      bodies.push((await request.json()) as Record<string, unknown>)
      return HttpResponse.json({
        choices: [{ message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.001 },
      })
    }),
  )
  return bodies
}

const validBody = (extra: Record<string, unknown> = {}) => ({
  profileId: 'p1',
  messages: [{ role: 'user', content: 'quanto custa o intensivo?' }],
  ...extra,
})

describe('POST /api/playground-ruth/chat', () => {
  const original = process.env.PLAYGROUND_RUTH_PASSWORD
  beforeEach(() => {
    __resetRateLimitForTests()
    process.env.PLAYGROUND_RUTH_PASSWORD = SENHA
    delete process.env.PLAYGROUND_RUTH_ACCOUNT_ID
  })
  afterEach(() => {
    if (original === undefined) delete process.env.PLAYGROUND_RUTH_PASSWORD
    else process.env.PLAYGROUND_RUTH_PASSWORD = original
  })

  it('503 sem env de senha / 401 senha errada', async () => {
    delete process.env.PLAYGROUND_RUTH_PASSWORD
    expect((await POST(req(validBody()))).status).toBe(503)
    process.env.PLAYGROUND_RUTH_PASSWORD = SENHA
    const bad = new Request('http://localhost/api/playground-ruth/chat', {
      method: 'POST',
      headers: { 'x-playground-password': 'x' },
      body: JSON.stringify(validBody()),
    })
    expect((await POST(bad)).status).toBe(401)
  })

  it('422: caps e forma do body', async () => {
    // sem profileId
    expect((await POST(req({ messages: [{ role: 'user', content: 'oi' }] }))).status).toBe(422)
    // mais de 40 mensagens
    const many = Array.from({ length: 41 }, () => ({ role: 'user', content: 'oi' }))
    expect((await POST(req(validBody({ messages: many })))).status).toBe(422)
    // persona acima do cap (30k — precisa comportar a persona real de ~20.3k)
    expect(
      (await POST(req(validBody({ personaPrompt: 'x'.repeat(30001) })))).status,
    ).toBe(422)
    // última mensagem não é do cliente
    expect(
      (
        await POST(
          req(
            validBody({
              messages: [
                { role: 'user', content: 'oi' },
                { role: 'assistant', content: 'olá' },
              ],
            }),
          ),
        )
      ).status,
    ).toBe(422)
  })

  it('persona editada no request chega no system enviado ao OpenRouter', async () => {
    const { db } = makeDb()
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const bodies = mockOpenRouter('Olá!')
    const res = await POST(req(validBody({ personaPrompt: 'PERSONA-V2-EDITADA' })))
    expect(res.status).toBe(200)
    const msgs = bodies[0].messages as { role: string; content: string }[]
    expect(msgs[0].role).toBe('system')
    expect(msgs[0].content).toContain('PERSONA-V2-EDITADA')
    expect(msgs[0].content).not.toContain('PERSONA-DO-BANCO')
  })

  it('opening:true remove transferir_humano das tools do request', async () => {
    const { db } = makeDb()
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const bodies = mockOpenRouter('Oi, sou a Ruth!')
    await POST(req(validBody({ opening: true, contactId: 'ct-1' })))
    const tools = bodies[0].tools as { function: { name: string } }[]
    const names = tools.map((t) => t.function.name)
    expect(names).not.toContain('transferir_humano')
    expect(names).toContain('encerrar')
  })

  it('zero escrita no banco, mesmo com enviar_link_venda (dry) e contactId vazio', async () => {
    const { db, writes } = makeDb({
      ai_courses: [{ slug: 'mb', nome: 'MB', posicionamento: null }],
      ai_courses__single: { nome: 'MB', link_venda: 'https://pay.x/mb' },
    })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    // 1ª resposta pede a tool; a 2ª entrega o texto final
    let call = 0
    server.use(
      http.post(OPENROUTER, async () => {
        call++
        if (call === 1) {
          return HttpResponse.json({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'tc1',
                      function: { name: 'enviar_link_venda', arguments: '{"slug":"mb"}' },
                    },
                  ],
                },
              },
            ],
          })
        }
        return HttpResponse.json({
          choices: [
            { message: { role: 'assistant', content: 'Aqui está o link!' }, finish_reason: 'stop' },
          ],
        })
      }),
    )
    const res = await POST(req(validBody()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { events: { linkDryRun: boolean } }
    expect(body.events.linkDryRun).toBe(true)
    // NENHUMA escrita em nenhuma tabela (link_tokens, ai_agent_runs, conversations, messages)
    expect(writes).toHaveLength(0)
  })

  it('resposta multi-parágrafo vira múltiplas bolhas', async () => {
    const { db } = makeDb()
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    mockOpenRouter('Primeira bolha.\n\nSegunda bolha.\n\nTerceira bolha.')
    const res = await POST(req(validBody()))
    const body = (await res.json()) as { bubbles: string[] }
    expect(body.bubbles).toEqual(['Primeira bolha.', 'Segunda bolha.', 'Terceira bolha.'])
  })

  it('erro do OpenRouter → 200 com telemetry.error (a página mostra)', async () => {
    const { db } = makeDb()
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    server.use(http.post(OPENROUTER, () => HttpResponse.json({ error: 'boom' }, { status: 500 })))
    const res = await POST(req(validBody()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { telemetry: { error: { phase: string } | null } }
    expect(body.telemetry.error?.phase).toBe('llm')
  })

  it('502 quando a conta não tem chave OpenRouter configurada', async () => {
    const { db } = makeDb({ integrations_config: null })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const res = await POST(req(validBody()))
    expect(res.status).toBe(502)
  })

  it('courseOverride de posicionamento entra no catálogo do system prompt', async () => {
    const { db } = makeDb({
      ai_courses: [{ slug: 'mb', nome: 'MB', posicionamento: 'posicionamento-original' }],
    })
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const bodies = mockOpenRouter('Ok!')
    const res = await POST(
      req(validBody({ courseOverrides: { mb: { posicionamento: 'POSICIONAMENTO-RASCUNHO' } } })),
    )
    expect(res.status).toBe(200)
    const system = (bodies[0].messages as { content: string }[])[0].content
    expect(system).toContain('POSICIONAMENTO-RASCUNHO')
    expect(system).not.toContain('posicionamento-original')
  })

  it('422 para courseOverrides malformado (campo acima do cap)', async () => {
    const res = await POST(
      req(validBody({ courseOverrides: { mb: { condicao_vigente: 'x'.repeat(4001) } } })),
    )
    expect(res.status).toBe(422)
  })

  it('override de modelo chega no body do OpenRouter; ausente usa o do perfil', async () => {
    const { db } = makeDb()
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const bodies = mockOpenRouter('Ok!')
    await POST(req(validBody({ model: 'anthropic/claude-haiku-4.5' })))
    expect(bodies[0].model).toBe('anthropic/claude-haiku-4.5')
    await POST(req(validBody()))
    expect(bodies[1].model).toBe(PROFILE.model)
  })

  it('campaignContext do body vira o bloco CONTEXTO DA CAMPANHA no system', async () => {
    const { db } = makeDb()
    vi.mocked(supabaseAdmin).mockReturnValue(db)
    const bodies = mockOpenRouter('Ok!')
    const res = await POST(req(validBody({ campaignContext: 'Ação: oferecer o ENEM.' })))
    expect(res.status).toBe(200)
    const system = (bodies[0].messages as { content: string }[])[0].content
    expect(system).toContain('CONTEXTO DA CAMPANHA')
    expect(system).toContain('Ação: oferecer o ENEM.')
  })

  it('422 para campaignContext acima do cap de 2.000', async () => {
    const res = await POST(req(validBody({ campaignContext: 'x'.repeat(2001) })))
    expect(res.status).toBe(422)
  })

  it('422 para id de modelo inválido', async () => {
    expect((await POST(req(validBody({ model: 'sem-barra' })))).status).toBe(422)
    expect((await POST(req(validBody({ model: 'a/b c' })))).status).toBe(422)
  })
})
