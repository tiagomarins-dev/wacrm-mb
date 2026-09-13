import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBlueprintAudience } from './audience'

// Fake chainable por tabela (padrão de send-engine.test.ts): registra os
// filtros aplicados e resolve por tabela.
interface Store {
  contacts: { id: string }[]
  /** Fila de respostas de contact_tags, consumida na ordem das queries. */
  tagResponses: { contact_id: string }[][]
  contactQueries: { in?: string[]; eqs: Record<string, string> }[]
  tagQueries: { in: unknown; range?: [number, number] }[]
}

function makeAdmin(store: Store) {
  function from(table: string) {
    const state: { in?: unknown; eqs: Record<string, string>; range?: [number, number] } = { eqs: {} }
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (col: string, val: string) => {
        state.eqs[col] = val
        return b
      },
      in: (_col: string, vals: unknown) => {
        state.in = vals
        return b
      },
      order: () => b,
      range: (from: number, to: number) => {
        state.range = [from, to]
        return b
      },
      then: (resolve: (v: unknown) => void) => {
        if (table === 'contacts') {
          store.contactQueries.push({ in: state.in as string[] | undefined, eqs: state.eqs })
          return resolve({ data: store.contacts, error: null })
        }
        if (table === 'contact_tags') {
          store.tagQueries.push({ in: state.in, range: state.range })
          return resolve({ data: store.tagResponses.shift() ?? [], error: null })
        }
        return resolve({ data: null, error: null })
      },
    }
    return b
  }
  return { from } as unknown as SupabaseClient
}

function makeStore(over: Partial<Store> = {}): Store {
  return {
    contacts: [],
    tagResponses: [],
    contactQueries: [],
    tagQueries: [],
    ...over,
  }
}

describe('resolveBlueprintAudience', () => {
  it('all: escopa por account_id e connection_id', async () => {
    const store = makeStore({ contacts: [{ id: 'c1' }, { id: 'c2' }] })
    const out = await resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
      type: 'all',
    })
    expect(out).toEqual([{ id: 'c1' }, { id: 'c2' }])
    expect(store.contactQueries[0].eqs).toEqual({ account_id: 'acct', connection_id: 'conn' })
  })

  it('tags: deduplica contact_ids e escopa contacts', async () => {
    const store = makeStore({
      contacts: [{ id: 'c1' }],
      tagResponses: [[{ contact_id: 'c1' }, { contact_id: 'c1' }]],
    })
    const out = await resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
      type: 'tags',
      tagIds: ['t1'],
    })
    expect(out).toEqual([{ id: 'c1' }])
    expect(store.contactQueries[0].in).toEqual(['c1'])
    expect(store.contactQueries[0].eqs).toEqual({ account_id: 'acct', connection_id: 'conn' })
  })

  it('tags vazio → [] sem tocar o banco', async () => {
    const store = makeStore()
    const out = await resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
      type: 'tags',
      tagIds: [],
    })
    expect(out).toEqual([])
    expect(store.contactQueries).toHaveLength(0)
  })

  it('excludeTagIds remove quem carrega a tag de exclusão', async () => {
    const store = makeStore({
      contacts: [{ id: 'c1' }, { id: 'c2' }],
      tagResponses: [[{ contact_id: 'c2' }]],
    })
    const out = await resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
      type: 'all',
      excludeTagIds: ['tx'],
    })
    expect(out).toEqual([{ id: 'c1' }])
  })

  it('tags: pagina contact_tags além de 1000 vínculos', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({ contact_id: `c${i + 1}` }))
    const store = makeStore({
      contacts: [{ id: 'c1' }],
      tagResponses: [firstPage, [{ contact_id: 'c1001' }]],
    })
    await resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
      type: 'tags',
      tagIds: ['t1'],
    })
    expect(store.tagQueries.map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ])
    // 1001 ids únicos → contacts consultado em páginas de 500
    const requested = store.contactQueries.flatMap((q) => q.in ?? [])
    expect(requested).toHaveLength(1001)
    expect(requested).toContain('c1001')
  })

  it('excludeTagIds: pagina e exclui quem está na segunda página', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, i) => ({ contact_id: `x${i}` }))
    const store = makeStore({
      contacts: [{ id: 'c1' }, { id: 'c2' }],
      tagResponses: [firstPage, [{ contact_id: 'c2' }]],
    })
    const out = await resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
      type: 'all',
      excludeTagIds: ['tx'],
    })
    expect(out).toEqual([{ id: 'c1' }])
    expect(store.tagQueries).toHaveLength(2)
  })

  it('rejeita audiência custom_field/csv (defesa contra JSONB editado)', async () => {
    const store = makeStore()
    await expect(
      resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
        type: 'custom_field',
      } as never),
    ).rejects.toThrow('unsupported audience type')
  })
})
