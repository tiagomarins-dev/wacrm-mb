import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execTool, buildToolDefs, semanasAteProva } from './tools'
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
    allowedTools: null,
    ...extra,
  }
}

const call = (name: string, args: object) => ({
  id: 'call-1',
  function: { name, arguments: JSON.stringify(args) },
})

describe('buildToolDefs', () => {
  it('sem allowed_tools (null) → as 5 ferramentas', () => {
    const names = buildToolDefs().map((t) => t.function.name)
    expect(names).toEqual(['get_curso', 'enviar_link_venda', 'buscar_suporte', 'transferir_humano', 'encerrar'])
  })

  it('subset de domínio → filtra domínio mas PRESERVA controle (C2)', () => {
    const names = buildToolDefs(['get_curso']).map((t) => t.function.name)
    expect(names).toContain('get_curso')
    expect(names).toContain('transferir_humano') // controle sempre
    expect(names).toContain('encerrar') // controle sempre
    expect(names).not.toContain('buscar_suporte')
    expect(names).not.toContain('enviar_link_venda')
  })

  it('tool desconhecida no array → ignorada (no-op), controle mantido', () => {
    const names = buildToolDefs(['nao_existe']).map((t) => t.function.name)
    expect(names).toEqual(['transferir_humano', 'encerrar'])
  })

  it('opening → remove transferir_humano (não encaminha na 1ª resposta)', () => {
    const names = buildToolDefs(null, true).map((t) => t.function.name)
    expect(names).not.toContain('transferir_humano')
    expect(names).toContain('encerrar') // controle não-transfer permanece
    expect(names).toContain('get_curso')
  })

  it('opening + allowed_tools → filtra domínio E remove transferir_humano', () => {
    const names = buildToolDefs(['get_curso'], true).map((t) => t.function.name)
    expect(names).not.toContain('transferir_humano')
    expect(names).toContain('get_curso')
    expect(names).toContain('encerrar')
    expect(names).not.toContain('buscar_suporte')
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

  it('curso com data_prova → output.prova com semanas restantes; sem data → campo ausente', async () => {
    const futuro = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const { db } = makeDb({ ai_courses: { nome: 'Intensivo', data_prova: futuro } })
    const r = await execTool(makeCtx(db), call('get_curso', { slug: 'intensivo' }))
    const prova = (r.output as { prova?: { semanas_restantes: number; correcoes_semanais_estimadas: number } }).prova
    expect(prova?.semanas_restantes).toBeGreaterThanOrEqual(2)
    expect(prova?.correcoes_semanais_estimadas).toBe(prova?.semanas_restantes)

    const { db: db2 } = makeDb({ ai_courses: { nome: 'Sem prova' } })
    const r2 = await execTool(makeCtx(db2), call('get_curso', { slug: 'x' }))
    expect((r2.output as { prova?: unknown }).prova).toBeUndefined()
  })
})

// Helper puro: semanas de hoje (fuso SP) até a prova, arredondando p/ cima.
describe('semanasAteProva', () => {
  const now = new Date('2026-07-17T15:00:00-03:00') // 17/07/2026 em SP

  it('17/07 → 08/11 (ENEM) = 114 dias → 17 semanas', () => {
    expect(semanasAteProva('2026-11-08', now)).toBe(17)
  })

  it('exatamente 7 dias → 1; 8 dias → 2 (arredonda p/ cima)', () => {
    expect(semanasAteProva('2026-07-24', now)).toBe(1)
    expect(semanasAteProva('2026-07-25', now)).toBe(2)
  })

  it('prova hoje → 1 (nunca 0 com prova futura/atual)', () => {
    expect(semanasAteProva('2026-07-17', now)).toBe(1)
  })

  it('prova no passado → null', () => {
    expect(semanasAteProva('2026-07-16', now)).toBeNull()
  })

  it('null/inválida → null', () => {
    expect(semanasAteProva(null, now)).toBeNull()
    expect(semanasAteProva('08/11/2026', now)).toBeNull()
    expect(semanasAteProva('', now)).toBeNull()
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
