import { describe, expect, it } from 'vitest'
import { getCurso, searchSupport, listSupportCategories } from './knowledge'

// Fake db chainável + thenable, no estilo de link-tracking/token.test.ts.
// Captura a tabela e os pares .eq() p/ asserções de isolamento por account_id.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(result: { data: any; error: any }) {
  const calls = { table: '' as string, eqs: [] as [string, unknown][] }
  const b: Record<string, unknown> = {
    select: () => b,
    eq: (col: string, val: unknown) => (calls.eqs.push([col, val]), b),
    or: () => b,
    limit: () => Promise.resolve(result),
    maybeSingle: () => Promise.resolve(result),
    then: (f: (v: unknown) => unknown) => Promise.resolve(result).then(f),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = { from: (t: string) => ((calls.table = t), b) } as any
  return { db, calls }
}

describe('getCurso', () => {
  it('curso ativo da conta → retorna a row e filtra por account_id', async () => {
    const { db, calls } = makeDb({ data: { slug: 'intensivo', nome: 'Intensivo' }, error: null })
    const curso = await getCurso(db, 'acc-1', 'intensivo')
    expect(curso?.slug).toBe('intensivo')
    expect(calls.table).toBe('ai_courses')
    // M3: precisa filtrar account_id explícito (defense-in-depth).
    expect(calls.eqs).toContainEqual(['account_id', 'acc-1'])
    expect(calls.eqs).toContainEqual(['ativo', true])
  })

  it('inexistente → null', async () => {
    const { db } = makeDb({ data: null, error: null })
    expect(await getCurso(db, 'acc-1', 'nao-existe')).toBeNull()
  })

  it('erro de query → null (não vaza)', async () => {
    const { db } = makeDb({ data: null, error: { message: 'boom' } })
    expect(await getCurso(db, 'acc-1', 'x')).toBeNull()
  })
})

describe('searchSupport', () => {
  it('query vazia → [] sem tocar o banco', async () => {
    const { db } = makeDb({ data: [{ id: '1' }], error: null })
    expect(await searchSupport(db, 'acc-1', '   ')).toEqual([])
  })

  it('com resultado → retorna artigos e filtra account_id', async () => {
    const { db, calls } = makeDb({ data: [{ id: '1', titulo: 'Acesso' }], error: null })
    const res = await searchSupport(db, 'acc-1', 'acesso plataforma')
    expect(res).toHaveLength(1)
    expect(calls.table).toBe('ai_support_articles')
    expect(calls.eqs).toContainEqual(['account_id', 'acc-1'])
  })

  it('sem resultado → [] (engine sinaliza transferir, não inventa)', async () => {
    const { db } = makeDb({ data: [], error: null })
    expect(await searchSupport(db, 'acc-1', 'algo')).toEqual([])
  })
})

describe('listSupportCategories', () => {
  it('deduplica categorias', async () => {
    const { db } = makeDb({
      data: [{ categoria: 'acesso' }, { categoria: 'acesso' }, { categoria: 'financeiro' }],
      error: null,
    })
    const cats = await listSupportCategories(db, 'acc-1')
    expect(cats.sort()).toEqual(['acesso', 'financeiro'])
  })
})
