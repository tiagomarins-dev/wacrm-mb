import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Fake do Supabase por tabela/RPC (padrão de mb-sync/sync.test.ts) ──
interface Store {
  accounts: string[]
  candidates: string[]
  members: string[]
  purchased: string[]
  mappedInMbSync: boolean
  rpcRanges: [number, number][]
  memberRanges: [number, number][]
  purchasedCalls: string[][]
  upserts: { rows: unknown[]; opts: unknown }[]
  deletes: { eqs: Record<string, unknown>; ins: Record<string, unknown[]> }[]
}

const h = vi.hoisted(() => ({
  store: null as unknown as Store,
  resolveSupportConfig: vi.fn(),
  resolveImportTagIds: vi.fn(),
}))

vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => makeDb(h.store) }))
vi.mock('@/lib/connections/support', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connections/support')>()
  return { ...actual, resolveSupportConfig: h.resolveSupportConfig }
})
vi.mock('@/lib/contacts/resolve-import-tags', () => ({ resolveImportTagIds: h.resolveImportTagIds }))

import { runOpportunityTagSync } from './tag-sync'
import { SupportConnectionError } from '@/lib/connections/support'

type State = {
  op: 'select' | 'upsert' | 'delete'
  payload?: unknown
  opts?: unknown
  eqs: Record<string, unknown>
  ins: Record<string, unknown[]>
  range?: [number, number]
}

function page<T>(all: T[], range?: [number, number]): T[] {
  const [from, to] = range ?? [0, all.length - 1]
  return all.slice(from, to + 1)
}

function makeDb(store: Store) {
  // Builder encadeável; `resolve` decide a resposta por tabela ou RPC.
  function builder(resolve: (s: State) => { data: unknown; error: unknown }) {
    const s: State = { op: 'select', eqs: {}, ins: {} }
    const b: Record<string, unknown> = {
      select: () => b,
      upsert: (p: unknown, o: unknown) => ((s.op = 'upsert'), (s.payload = p), (s.opts = o), b),
      delete: () => ((s.op = 'delete'), b),
      eq: (c: string, v: unknown) => ((s.eqs[c] = v), b),
      in: (c: string, v: unknown[]) => ((s.ins[c] = v), b),
      order: () => b,
      limit: () => b,
      range: (f: number, t: number) => ((s.range = [f, t]), b),
      then: (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(s)).then(ok, ko),
    }
    return b
  }

  function from(table: string) {
    return builder((s) => {
      if (table === 'mb_checkout_products') return { data: store.accounts.map((account_id) => ({ account_id })), error: null }
      if (table === 'mb_class_sync') return { data: store.mappedInMbSync ? [{ id: 'm1' }] : [], error: null }
      if (table === 'contact_tags') {
        if (s.op === 'upsert') {
          store.upserts.push({ rows: s.payload as unknown[], opts: s.opts })
          return { data: null, error: null }
        }
        if (s.op === 'delete') {
          store.deletes.push({ eqs: s.eqs, ins: s.ins })
          return { data: null, error: null }
        }
        store.memberRanges.push(s.range ?? [0, 0])
        return { data: page(store.members, s.range).map((contact_id) => ({ contact_id })), error: null }
      }
      return { data: null, error: null }
    })
  }

  function rpc(name: string, args: Record<string, unknown>) {
    return builder((s) => {
      if (name === 'opportunities_for_account') {
        store.rpcRanges.push(s.range ?? [0, 0])
        return { data: page(store.candidates, s.range).map((contact_id) => ({ contact_id })), error: null }
      }
      if (name === 'opportunity_purchased') {
        const ids = args.p_contact_ids as string[]
        store.purchasedCalls.push(ids)
        return { data: ids.filter((id) => store.purchased.includes(id)).map((contact_id) => ({ contact_id })), error: null }
      }
      return { data: null, error: null }
    })
  }

  return { from, rpc }
}

const ACC = 'acc-1'
const TAG = 'tag-oportunidade'
const ids = (n: number, prefix = 'c') => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

function freshStore(over: Partial<Store> = {}): Store {
  return {
    accounts: [ACC],
    candidates: [],
    members: [],
    purchased: [],
    mappedInMbSync: false,
    rpcRanges: [],
    memberRanges: [],
    purchasedCalls: [],
    upserts: [],
    deletes: [],
    ...over,
  }
}

beforeEach(() => {
  h.store = freshStore()
  h.resolveSupportConfig.mockReset()
  h.resolveSupportConfig.mockResolvedValue({ id: 'conn', user_id: 'owner-1', account_id: ACC, archived_at: null })
  h.resolveImportTagIds.mockReset()
  h.resolveImportTagIds.mockResolvedValue({ tagIdByKey: new Map([['oportunidade', TAG]]), skippedNames: [] })
})

describe('runOpportunityTagSync', () => {
  it('sem produtos cadastrados → nenhuma conta processada', async () => {
    h.store = freshStore({ accounts: [] })
    expect(await runOpportunityTagSync({ dry: false })).toEqual({ accounts: [] })
  })

  it('aplica a tag só em quem entrou e ainda não é membro', async () => {
    h.store = freshStore({ candidates: ['a', 'b'], members: ['a'] })
    const out = await runOpportunityTagSync({ dry: false })
    expect(out.accounts[0]).toMatchObject({ candidates: 2, tagged: 1, untagged: 0, aborted: null })
    expect(h.store.upserts[0].rows).toEqual([{ contact_id: 'b', tag_id: TAG }])
    expect(h.store.upserts[0].opts).toEqual({ onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    expect(h.resolveImportTagIds).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountId: ACC, userId: 'owner-1', tagNames: ['oportunidade'], canCreateTags: true,
    }))
  })

  it('pagina candidatos acima de 1000', async () => {
    h.store = freshStore({ candidates: ids(1001) })
    const out = await runOpportunityTagSync({ dry: false })
    expect(h.store.rpcRanges).toEqual([[0, 999], [1000, 1999]])
    expect(out.accounts[0].candidates).toBe(1001)
  })

  it('não remove quem só envelheceu (não comprou)', async () => {
    h.store = freshStore({ candidates: [], members: ['velho'], purchased: [] })
    const out = await runOpportunityTagSync({ dry: false })
    expect(out.accounts[0].untagged).toBe(0)
    expect(h.store.deletes).toHaveLength(0)
  })

  it('remove quem comprou, filtrando pela tag', async () => {
    h.store = freshStore({ members: ['x', 'y'], purchased: ['y'] })
    const out = await runOpportunityTagSync({ dry: false })
    expect(out.accounts[0].untagged).toBe(1)
    expect(h.store.deletes[0]).toEqual({ eqs: { tag_id: TAG }, ins: { contact_id: ['y'] } })
  })

  it('carrega todos os membros (acima de 1000) antes de verificar compra em blocos de 200', async () => {
    h.store = freshStore({ members: ids(1001, 'm'), purchased: ['m1000'] })
    const out = await runOpportunityTagSync({ dry: false })
    expect(h.store.memberRanges).toEqual([[0, 999], [1000, 1999]])
    expect(h.store.purchasedCalls).toHaveLength(6)
    expect(h.store.purchasedCalls.flat()).toHaveLength(1001)
    expect(out.accounts[0].untagged).toBe(1)
  })

  it('dry: conta sem gravar e não cria a tag', async () => {
    h.store = freshStore({ candidates: ['a'], members: ['b'], purchased: ['b'] })
    const out = await runOpportunityTagSync({ dry: true })
    expect(out.accounts[0]).toMatchObject({ tagged: 1, untagged: 1 })
    expect(h.store.upserts).toHaveLength(0)
    expect(h.store.deletes).toHaveLength(0)
    expect(h.resolveImportTagIds).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ canCreateTags: false }))
  })

  it('dry com a tag ainda inexistente → tagged = candidatos, nada gravado', async () => {
    h.store = freshStore({ candidates: ['a', 'b'] })
    h.resolveImportTagIds.mockResolvedValue({ tagIdByKey: new Map(), skippedNames: ['oportunidade'] })
    const out = await runOpportunityTagSync({ dry: true })
    expect(out.accounts[0]).toMatchObject({ candidates: 2, tagged: 2, untagged: 0 })
    expect(h.store.upserts).toHaveLength(0)
  })

  it('tag mapeada no mb-sync → aborta sem mexer em vínculos', async () => {
    h.store = freshStore({ candidates: ['a'], members: ['b'], purchased: ['b'], mappedInMbSync: true })
    const out = await runOpportunityTagSync({ dry: false })
    expect(out.accounts[0].aborted).toBe('tag_mapped_in_mb_sync')
    expect(h.store.upserts).toHaveLength(0)
    expect(h.store.deletes).toHaveLength(0)
  })

  it('conta sem conexão de Suporte → aborta com o motivo', async () => {
    h.resolveSupportConfig.mockRejectedValue(new SupportConnectionError('unconfigured'))
    const out = await runOpportunityTagSync({ dry: false })
    expect(out.accounts[0].aborted).toBe('support_unconfigured')
    expect(h.store.rpcRanges).toHaveLength(0)
  })

  it('idempotente: todos já marcados e ninguém comprou → nada a gravar', async () => {
    h.store = freshStore({ candidates: ['a', 'b'], members: ['a', 'b'] })
    const out = await runOpportunityTagSync({ dry: false })
    expect(out.accounts[0]).toMatchObject({ tagged: 0, untagged: 0 })
    expect(h.store.upserts).toHaveLength(0)
    expect(h.store.deletes).toHaveLength(0)
  })
})
