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
  tagQueries: { in: unknown }[]
}

function makeAdmin(store: Store) {
  function from(table: string) {
    const state: { in?: unknown; eqs: Record<string, string> } = { eqs: {} }
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
      then: (resolve: (v: unknown) => void) => {
        if (table === 'contacts') {
          store.contactQueries.push({ in: state.in as string[] | undefined, eqs: state.eqs })
          return resolve({ data: store.contacts, error: null })
        }
        if (table === 'contact_tags') {
          store.tagQueries.push({ in: state.in })
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

  it('rejeita audiência custom_field/csv (defesa contra JSONB editado)', async () => {
    const store = makeStore()
    await expect(
      resolveBlueprintAudience(makeAdmin(store), 'acct', 'conn', {
        type: 'custom_field',
      } as never),
    ).rejects.toThrow('unsupported audience type')
  })
})
