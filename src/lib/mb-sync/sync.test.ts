import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MbStudentRow } from './reconcile'

// ── Fake do Supabase por tabela (padrão de broadcast/send-engine.test.ts) ──
interface Store {
  pairs: { account_id: string; mb_course_id: number; tag_id: string }[]
  tags: { id: string; account_id: string }[]
  lastRun: { students: number; course_ids: number[] } | null
  contacts: { id: string; phone_normalized: string }[]
  members: { id: string; contact_id: string }[]
  /** insert em bloco de contacts falha com 23505 */
  bulkConflict: boolean
  /** telefones que já existem (23505 no insert linha a linha) → id existente */
  existingByPhone: Record<string, string>
  // registros
  runs: Record<string, unknown>[]
  contactInserts: Record<string, unknown>[][]
  tagUpserts: { rows: unknown[]; opts: unknown }[]
  tagDeletes: { eqs: Record<string, unknown>; ins: Record<string, unknown> }[]
  memberRanges: [number, number][]
  touched: string[]
}

const h = vi.hoisted(() => ({
  store: null as unknown as Store,
  fetchCourseStudents: vi.fn(),
  resolveMbApiKey: vi.fn(),
  resolveSupportConfig: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => makeDb(h.store) }))
vi.mock('./platform-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform-api')>()
  return { ...actual, fetchCourseStudents: h.fetchCourseStudents, resolveMbApiKey: h.resolveMbApiKey }
})
vi.mock('@/lib/connections/support', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connections/support')>()
  return { ...actual, resolveSupportConfig: h.resolveSupportConfig }
})

import { runMbClassSync } from './sync'
import { MbApiError } from './platform-api'
import { SupportConnectionError } from '@/lib/connections/support'

type State = {
  op: 'select' | 'insert' | 'upsert' | 'delete'
  payload?: unknown
  opts?: unknown
  eqs: Record<string, unknown>
  ins: Record<string, unknown[]>
  range?: [number, number]
}

function makeDb(store: Store) {
  function resolve(table: string, s: State, mode: 'many' | 'single' | 'maybe') {
    store.touched.push(`${table}:${s.op}`)
    if (table === 'mb_class_sync') return { data: store.pairs, error: null }
    if (table === 'tags') return { data: store.tags, error: null }
    if (table === 'mb_class_sync_runs') {
      if (s.op === 'insert') {
        store.runs.push(s.payload as Record<string, unknown>)
        return { data: null, error: null }
      }
      return { data: store.lastRun, error: null }
    }
    if (table === 'contacts') {
      if (s.op === 'insert') {
        if (Array.isArray(s.payload)) {
          if (store.bulkConflict) return { data: null, error: { code: '23505' } }
          store.contactInserts.push(s.payload as Record<string, unknown>[])
          return { data: (s.payload as { phone: string }[]).map((r) => ({ id: `new-${r.phone}` })), error: null }
        }
        const row = s.payload as { phone: string }
        if (store.existingByPhone[row.phone]) return { data: null, error: { code: '23505' } }
        store.contactInserts.push([row as unknown as Record<string, unknown>])
        return { data: { id: `new-${row.phone}` }, error: null }
      }
      if (mode === 'maybe') {
        const id = store.existingByPhone[s.eqs.phone_normalized as string]
        return { data: id ? { id } : null, error: null }
      }
      const keys = s.ins.phone_normalized ?? []
      return { data: store.contacts.filter((c) => keys.includes(c.phone_normalized)), error: null }
    }
    if (table === 'contact_tags') {
      if (s.op === 'upsert') {
        store.tagUpserts.push({ rows: s.payload as unknown[], opts: s.opts })
        return { data: null, error: null }
      }
      if (s.op === 'delete') {
        store.tagDeletes.push({ eqs: s.eqs, ins: s.ins })
        return { data: null, error: null }
      }
      const [from, to] = s.range ?? [0, 999]
      store.memberRanges.push([from, to])
      return { data: store.members.slice(from, to + 1), error: null }
    }
    return { data: null, error: null }
  }

  function from(table: string) {
    const s: State = { op: 'select', eqs: {}, ins: {} }
    const run = (mode: 'many' | 'single' | 'maybe') => Promise.resolve(resolve(table, s, mode))
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((s.op = 'insert'), (s.payload = p), b),
      upsert: (p: unknown, o: unknown) => ((s.op = 'upsert'), (s.payload = p), (s.opts = o), b),
      delete: () => ((s.op = 'delete'), b),
      eq: (c: string, v: unknown) => ((s.eqs[c] = v), b),
      in: (c: string, v: unknown[]) => ((s.ins[c] = v), b),
      is: () => b,
      order: () => b,
      limit: () => b,
      range: (f: number, t: number) => ((s.range = [f, t]), b),
      single: () => run('single'),
      maybeSingle: () => run('maybe'),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => run('many').then(ok, ko),
    }
    return b
  }
  return { from }
}

// ── Fixtures ──
const ACC = 'acc-1'
const TAG = 'tag-1'
const SUPPORT = { id: 'conn-sup', user_id: 'owner-1', account_id: ACC, archived_at: null }

function student(id: number, telefone: string, over: Partial<MbStudentRow> = {}): MbStudentRow {
  return {
    id_aluno: id,
    id_curso: 90,
    nome: `Aluno ${id}`,
    email: `a${id}@gmail.com`,
    telefone,
    usuario_vigente: 'S',
    ...over,
  }
}

// API devolve, por curso consultado, só os alunos daquele curso (curso vigente).
function apiReturns(rows: MbStudentRow[]) {
  h.fetchCourseStudents.mockImplementation(async (_key: string, id: number) => ({
    found: true,
    curso: { id_curso: id, nome_curso: `Curso ${id}`, vigente: 'S' },
    ativos: rows.filter((r) => r.id_curso === id),
  }))
}

function freshStore(over: Partial<Store> = {}): Store {
  return {
    pairs: [{ account_id: ACC, mb_course_id: 90, tag_id: TAG }],
    tags: [{ id: TAG, account_id: ACC }],
    lastRun: null,
    contacts: [],
    members: [],
    bulkConflict: false,
    existingByPhone: {},
    runs: [],
    contactInserts: [],
    tagUpserts: [],
    tagDeletes: [],
    memberRanges: [],
    touched: [],
    ...over,
  }
}

const touchedContacts = () =>
  h.store.touched.some((t) => t.startsWith('contacts') || t.startsWith('contact_tags'))

beforeEach(() => {
  h.store = freshStore()
  h.fetchCourseStudents.mockReset()
  h.resolveMbApiKey.mockReset()
  h.resolveMbApiKey.mockResolvedValue('chave')
  h.resolveSupportConfig.mockReset()
  h.resolveSupportConfig.mockResolvedValue(SUPPORT)
})

describe('runMbClassSync', () => {
  it('sem pares → nada a fazer e não chama a API', async () => {
    h.store = freshStore({ pairs: [] })
    expect(await runMbClassSync({ dry: false })).toEqual({ tags: [] })
    expect(h.fetchCourseStudents).not.toHaveBeenCalled()
  })

  it('curso sem alunos ativos → aborta sem tocar contatos nem vínculos', async () => {
    apiReturns([])
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('no_eligible_students')
    expect(h.store.runs[0]).toMatchObject({ aborted_reason: 'no_eligible_students', course_ids: [90] })
    expect(touchedContacts()).toBe(false)
  })

  it('curso encerrado na plataforma entra sem alunos (guarda congela a tag)', async () => {
    h.fetchCourseStudents.mockResolvedValue({
      found: true,
      curso: { id_curso: 90, nome_curso: 'X', vigente: 'N' },
      ativos: [student(1, '5521900000001')],
    })
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('no_eligible_students')
    expect(touchedContacts()).toBe(false)
  })

  it('queda acima de 50% contra o último run do mesmo conjunto → aborta', async () => {
    h.store = freshStore({ lastRun: { students: 100, course_ids: [90] } })
    apiReturns(Array.from({ length: 30 }, (_, i) => student(i + 1, `55219876${String(i).padStart(5, '0')}`)))
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0]).toMatchObject({ aborted: 'drop_over_50pct', students: 30 })
    expect(h.store.tagUpserts).toHaveLength(0)
    expect(h.store.tagDeletes).toHaveLength(0)
  })

  it('base de outro conjunto de cursos não trava a tag', async () => {
    h.store = freshStore({ lastRun: { students: 100, course_ids: [90, 91] } })
    apiReturns([student(1, '5521987654321')])
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBeNull()
    expect(h.store.tagUpserts).toHaveLength(1)
  })

  it('dry → calcula e não grava nada (nem o run)', async () => {
    h.store = freshStore({
      contacts: [{ id: 'ct-a', phone_normalized: '5521900000001' }],
      members: [{ id: 'm-c', contact_id: 'ct-c' }],
    })
    apiReturns([student(1, '5521900000001'), student(2, '5521900000002')])
    const out = await runMbClassSync({ dry: true })
    expect(out.tags[0]).toMatchObject({ added: 2, removed: 1, created: 1, aborted: null })
    expect(h.store.contactInserts).toHaveLength(0)
    expect(h.store.tagUpserts).toHaveLength(0)
    expect(h.store.tagDeletes).toHaveLength(0)
    expect(h.store.runs).toHaveLength(0)
  })

  it('caminho feliz: cria faltante, vincula quem entrou, remove quem saiu e grava o run', async () => {
    h.store = freshStore({
      contacts: [{ id: 'ct-a', phone_normalized: '5521900000001' }],
      members: [{ id: 'm-c', contact_id: 'ct-c' }],
    })
    apiReturns([student(1, '5521900000001'), student(2, '21900000002', { nome: 'Bia' })])
    const out = await runMbClassSync({ dry: false })

    expect(h.fetchCourseStudents).toHaveBeenCalledWith('chave', 90)
    expect(h.store.contactInserts[0]).toEqual([
      { account_id: ACC, user_id: 'owner-1', connection_id: 'conn-sup', phone: '5521900000002', name: 'Bia' },
    ])
    expect(h.store.tagUpserts[0].rows).toEqual([
      { contact_id: 'ct-a', tag_id: TAG },
      { contact_id: 'new-5521900000002', tag_id: TAG },
    ])
    expect(h.store.tagUpserts[0].opts).toEqual({ onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    expect(h.store.tagDeletes[0]).toEqual({ eqs: { tag_id: TAG }, ins: { id: ['m-c'] } })
    expect(out.tags[0]).toMatchObject({ students: 2, added: 2, removed: 1, created: 1, aborted: null })
    expect(h.store.runs[0]).toMatchObject({ tag_id: TAG, added: 2, removed: 1, created: 1, aborted_reason: null })
  })

  it('idempotente: estado já igual não escreve vínculos nem cria contatos', async () => {
    h.store = freshStore({
      contacts: [{ id: 'ct-a', phone_normalized: '5521900000001' }],
      members: [{ id: 'm-a', contact_id: 'ct-a' }],
    })
    apiReturns([student(1, '5521900000001')])
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0]).toMatchObject({ added: 0, removed: 0, created: 0 })
    expect(h.store.tagUpserts).toHaveLength(0)
    expect(h.store.tagDeletes).toHaveLength(0)
    expect(h.store.contactInserts).toHaveLength(0)
  })

  it('23505 no bloco → linha a linha, reaproveitando o contato que já existe', async () => {
    h.store = freshStore({
      bulkConflict: true,
      existingByPhone: { '5521900000002': 'ct-existente' },
    })
    apiReturns([student(1, '5521900000001'), student(2, '5521900000002')])
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].created).toBe(1)
    expect(h.store.tagUpserts[0].rows).toEqual([
      { contact_id: 'new-5521900000001', tag_id: TAG },
      { contact_id: 'ct-existente', tag_id: TAG },
    ])
  })

  it('tag de outra conta → aborta sem chamar a API nem tocar vínculos', async () => {
    h.store = freshStore({ tags: [{ id: TAG, account_id: 'outra-conta' }] })
    apiReturns([student(1, '5521900000001')])
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('tag_account_mismatch')
    expect(h.fetchCourseStudents).not.toHaveBeenCalled()
    expect(touchedContacts()).toBe(false)
  })

  it('conexão de Suporte não configurada → aborta com o motivo', async () => {
    h.resolveSupportConfig.mockRejectedValue(new SupportConnectionError('unconfigured'))
    apiReturns([student(1, '5521900000001')])
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('support_unconfigured')
    expect(h.store.runs[0]).toMatchObject({ aborted_reason: 'support_unconfigured' })
  })

  it('conta sem chave da API → run api_unconfigured', async () => {
    h.resolveMbApiKey.mockResolvedValue(null)
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('api_unconfigured')
    expect(h.fetchCourseStudents).not.toHaveBeenCalled()
    expect(h.store.runs).toHaveLength(1)
  })

  it('erro da API (429) → aborta a tag sem gravar vínculos e não derruba o cron', async () => {
    h.fetchCourseStudents.mockRejectedValue(new MbApiError('rate_limited'))
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('api_rate_limited')
    expect(h.store.runs[0]).toMatchObject({ aborted_reason: 'api_rate_limited' })
    expect(touchedContacts()).toBe(false)
  })

  it('curso inexistente → course_not_found', async () => {
    h.fetchCourseStudents.mockResolvedValue({ found: false })
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('course_not_found')
  })

  it('chave recusada (401) para de chamar a API nos cursos seguintes', async () => {
    h.store = freshStore({
      pairs: [
        { account_id: ACC, mb_course_id: 90, tag_id: TAG },
        { account_id: ACC, mb_course_id: 88, tag_id: 'tag-2' },
      ],
      tags: [
        { id: TAG, account_id: ACC },
        { id: 'tag-2', account_id: ACC },
      ],
    })
    h.fetchCourseStudents.mockRejectedValue(new MbApiError('unauthorized'))
    const out = await runMbClassSync({ dry: false })
    expect(h.fetchCourseStudents).toHaveBeenCalledTimes(1)
    expect(out.tags.map((t) => t.aborted)).toEqual(['api_unauthorized', 'api_unauthorized'])
  })

  it('tag com dois cursos e um falhando → aborta a tag inteira', async () => {
    h.store = freshStore({
      pairs: [
        { account_id: ACC, mb_course_id: 90, tag_id: TAG },
        { account_id: ACC, mb_course_id: 88, tag_id: TAG },
      ],
    })
    h.fetchCourseStudents.mockImplementation(async (_k: string, id: number) => {
      if (id === 88) throw new MbApiError('http_500')
      return { found: true, curso: { id_curso: 90, nome_curso: 'X', vigente: 'S' }, ativos: [student(1, '5521900000001')] }
    })
    const out = await runMbClassSync({ dry: false })
    expect(out.tags[0].aborted).toBe('api_http_500')
    expect(touchedContacts()).toBe(false)
  })

  it('duas tags, uma abortada: a outra aplica normalmente', async () => {
    h.store = freshStore({
      pairs: [
        { account_id: ACC, mb_course_id: 90, tag_id: TAG },
        { account_id: ACC, mb_course_id: 88, tag_id: 'tag-2' },
      ],
      tags: [
        { id: TAG, account_id: ACC },
        { id: 'tag-2', account_id: ACC },
      ],
    })
    apiReturns([student(1, '5521900000001', { id_curso: 90 })])
    const out = await runMbClassSync({ dry: false })
    const byTag = Object.fromEntries(out.tags.map((t) => [t.tag_id, t]))
    expect(byTag['tag-2'].aborted).toBe('no_eligible_students')
    expect(byTag[TAG].aborted).toBeNull()
    expect(h.fetchCourseStudents.mock.calls.map((c) => c[1])).toEqual([90, 88])
  })

  it('mais de 1000 membros → pagina contact_tags', async () => {
    h.store = freshStore({
      contacts: [{ id: 'ct-a', phone_normalized: '5521900000001' }],
      members: Array.from({ length: 1001 }, (_, i) => ({ id: `m${i}`, contact_id: `x${i}` })),
    })
    apiReturns([student(1, '5521900000001')])
    const out = await runMbClassSync({ dry: true })
    expect(h.store.memberRanges).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    expect(out.tags[0].removed).toBe(1001)
  })

  it('mesmo curso em duas tags → uma chamada à API e as duas reconciliadas', async () => {
    h.store = freshStore({
      pairs: [
        { account_id: ACC, mb_course_id: 90, tag_id: TAG },
        { account_id: ACC, mb_course_id: 90, tag_id: 'tag-2' },
      ],
      tags: [
        { id: TAG, account_id: ACC },
        { id: 'tag-2', account_id: ACC },
      ],
    })
    apiReturns([student(1, '5521900000001')])
    const out = await runMbClassSync({ dry: false })
    expect(h.fetchCourseStudents).toHaveBeenCalledTimes(1)
    expect(out.tags.map((t) => t.aborted)).toEqual([null, null])
    expect(h.store.tagUpserts).toHaveLength(2)
  })
})
