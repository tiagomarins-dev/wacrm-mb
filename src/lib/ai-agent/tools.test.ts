import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execTool, buildToolDefs } from './tools'
import type { AgentCtx } from './llm'

// Fake db por tabela: devolve `data` canned no terminal e captura
// inserts/updates/eqs p/ asserção. Estilo de link-tracking/token.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(byTable: Record<string, any>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured = { inserts: [] as any[], updates: [] as any[], eqs: [] as [string, unknown][] }
  const builder = (table: string) => {
    const op = { type: 'select' as 'select' | 'insert' | 'update', payload: null as unknown }
    const result = () => {
      if (op.type === 'insert') {
        captured.inserts.push({ table, payload: op.payload })
        return { data: { id: 'x' }, error: null }
      }
      if (op.type === 'update') {
        captured.updates.push({ table, payload: op.payload })
        return { data: null, error: null }
      }
      return { data: byTable[table] ?? null, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((op.type = 'insert'), (op.payload = p), b),
      update: (p: unknown) => ((op.type = 'update'), (op.payload = p), b),
      eq: (c: string, v: unknown) => (captured.eqs.push([c, v]), b),
      or: () => b,
      limit: () => Promise.resolve(result()),
      maybeSingle: () => Promise.resolve(result()),
      then: (f: (v: unknown) => unknown) => Promise.resolve(result()).then(f),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: (t: string) => builder(t) } as any, captured }
}

function makeCtx(db: unknown, extra: Partial<AgentCtx> = {}): AgentCtx {
  return {
    db: db as never,
    accountId: 'acc-1',
    connectionId: 'conn-1',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    model: 'm',
    classifierModel: null,
    maxTurns: 8,
    system: '',
    messages: [],
    handoffRouting: null,
    ...extra,
  }
}

const call = (name: string, args: object) => ({
  id: 'call-1',
  function: { name, arguments: JSON.stringify(args) },
})

describe('buildToolDefs', () => {
  it('expõe as 5 ferramentas de roteamento', () => {
    const names = buildToolDefs().map((t) => t.function.name)
    expect(names).toEqual(['get_curso', 'enviar_link_venda', 'buscar_suporte', 'transferir_humano', 'encerrar'])
  })
})

describe('get_curso', () => {
  it('curso existe → devolve a ficha e detecta vendas, filtrando account_id', async () => {
    const { db, captured } = makeDb({
      ai_courses: { nome: 'Intensivo', condicao_vigente: '12x de R$ 86', link_venda: 'https://x' },
    })
    const r = await execTool(makeCtx(db), call('get_curso', { slug: 'intensivo' }))
    expect(r.detectedTopic).toBe('vendas')
    expect((r.output as { condicao_vigente: string }).condicao_vigente).toBe('12x de R$ 86')
    expect(captured.eqs).toContainEqual(['account_id', 'acc-1'])
  })

  it('curso inexistente → erro', async () => {
    const { db } = makeDb({ ai_courses: null })
    const r = await execTool(makeCtx(db), call('get_curso', { slug: 'x' }))
    expect((r.output as { error: string }).error).toMatch(/não encontrado/)
  })
})

describe('enviar_link_venda', () => {
  beforeEach(() => (process.env.NEXT_PUBLIC_SITE_URL = 'https://app.example.com'))
  afterEach(() => delete process.env.NEXT_PUBLIC_SITE_URL)

  it('minta token sem flow_run e devolve URL /r/<hex>', async () => {
    const { db, captured } = makeDb({ ai_courses: { nome: 'Intensivo', link_venda: 'https://pay.hotmart.com/x' } })
    const r = await execTool(makeCtx(db), call('enviar_link_venda', { slug: 'intensivo' }))
    const out = r.output as { url: string; curso: string }
    expect(out.url).toMatch(/^https:\/\/app\.example\.com\/r\/[0-9a-f]{32}$/)
    // token gravado com flow_id/run_id null e source='agent'
    const ins = captured.inserts.find((i) => i.table === 'link_tokens')
    expect(ins.payload.run_id).toBeNull()
    expect(ins.payload.source).toBe('agent')
  })

  it('curso sem link → sinaliza sem_link (não erro técnico)', async () => {
    const { db } = makeDb({ ai_courses: { nome: 'X', link_venda: null } })
    const r = await execTool(makeCtx(db), call('enviar_link_venda', { slug: 'x' }))
    expect((r.output as { sem_link: boolean }).sem_link).toBe(true)
    expect(r.detectedTopic).toBe('vendas')
  })
})

describe('buscar_suporte', () => {
  it('vazio → hint de transferir', async () => {
    const { db } = makeDb({ ai_support_articles: [] })
    const r = await execTool(makeCtx(db), call('buscar_suporte', { query: 'acesso' }))
    expect(r.detectedTopic).toBe('suporte')
    expect((r.output as { hint: string }).hint).toMatch(/transferir/)
  })

  it('com artigos → devolve titulo/conteudo', async () => {
    const { db } = makeDb({ ai_support_articles: [{ titulo: 'Login', conteudo: 'use seu email' }] })
    const r = await execTool(makeCtx(db), call('buscar_suporte', { query: 'login' }))
    expect((r.output as { results: unknown[] }).results).toHaveLength(1)
  })
})

describe('transferir_humano', () => {
  it('sinaliza handoff p/ o humano roteado (NÃO escreve DB — engine aplica pós-envio)', async () => {
    const { db, captured } = makeDb({})
    const ctx = makeCtx(db, { handoffRouting: { suporte: 'agent-9', vendas: 'agent-7' } })
    const r = await execTool(ctx, call('transferir_humano', { assunto: 'suporte', motivo: 'pediu atendente' }))
    expect(r.detectedTopic).toBe('suporte')
    expect(r.handoff).toEqual({ to: 'agent-9' })
    // tool não toca o banco — quem reatribui é o engine, depois de enviar a despedida
    expect(captured.updates).toHaveLength(0)
  })

  it('sem agente no routing → handoff com to=null (desatribui)', async () => {
    const { db, captured } = makeDb({})
    const r = await execTool(makeCtx(db), call('transferir_humano', { assunto: 'vendas' }))
    expect(r.handoff).toEqual({ to: null })
    expect(captured.updates).toHaveLength(0)
  })
})

describe('execTool — robustez', () => {
  it('argumentos JSON inválidos → erro tratado', async () => {
    const { db } = makeDb({})
    const r = await execTool(makeCtx(db), { id: 'c', function: { name: 'get_curso', arguments: '{bad' } })
    expect((r.output as { error: string }).error).toMatch(/inválidos/)
  })

  it('tool desconhecida → erro', async () => {
    const { db } = makeDb({})
    const r = await execTool(makeCtx(db), call('nao_existe', {}))
    expect((r.output as { error: string }).error).toMatch(/desconhecida/)
  })
})
