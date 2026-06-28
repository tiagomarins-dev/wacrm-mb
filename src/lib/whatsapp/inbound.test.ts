// ============================================================
// Testa findOrCreateGroupConversation (058): acha por chat_id (escopo de
// conta+conexão), cria com contact_id NULL/is_group=true, e recupera de
// race (índice único de grupo) re-resolvendo por chat_id.
// ============================================================
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findOrCreateGroupConversation } from './inbound'

// Mock chainável: select→eq*→maybeSingle e insert→select→single.
function makeDb(opts: {
  existing?: Record<string, unknown> | null
  insertResult?: { data: unknown; error: unknown }
  racedRow?: Record<string, unknown> | null
}) {
  const captured = { insertRow: null as Record<string, unknown> | null, selectCalls: 0 }
  let selectPhase: 'find' | 'raced' = 'find'

  function builder() {
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (row: Record<string, unknown>) => {
        captured.insertRow = row
        return {
          select: () => ({
            single: async () => opts.insertResult ?? { data: { id: 'new' }, error: null },
          }),
        }
      },
      eq: () => b,
      maybeSingle: async () => {
        captured.selectCalls++
        // 1ª query select = find inicial; query após insert falho = raced.
        if (selectPhase === 'find') return { data: opts.existing ?? null }
        return { data: opts.racedRow ?? null }
      },
    }
    return b
  }

  const db = {
    from: () => {
      const b = builder()
      // Após a 1ª resolução de find, a próxima é a recuperação de race.
      const origMaybe = b.maybeSingle as () => Promise<unknown>
      b.maybeSingle = async () => {
        const r = await origMaybe()
        selectPhase = 'raced'
        return r
      }
      return b
    },
  } as unknown as SupabaseClient

  return { db, captured }
}

describe('findOrCreateGroupConversation', () => {
  it('retorna a conversa de grupo existente sem inserir', async () => {
    const { db, captured } = makeDb({ existing: { id: 'grp-existente', is_group: true } })
    const r = await findOrCreateGroupConversation(db, 'a1', 'u1', 'k1', '120363@g.us', 'Turma')
    expect(r).toMatchObject({ id: 'grp-existente' })
    expect(captured.insertRow).toBeNull()
  })

  it('cria com contact_id NULL + is_group=true + chat_id', async () => {
    const { db, captured } = makeDb({ existing: null, insertResult: { data: { id: 'grp-novo' }, error: null } })
    const r = await findOrCreateGroupConversation(db, 'a1', 'u1', 'k1', '120363@g.us', 'Turma')
    expect(r).toMatchObject({ id: 'grp-novo' })
    expect(captured.insertRow).toMatchObject({
      account_id: 'a1', user_id: 'u1', connection_id: 'k1',
      contact_id: null, is_group: true, chat_id: '120363@g.us',
      last_message_text: '[grupo] Turma',
    })
  })

  it('sem groupName: last_message_text fica null', async () => {
    const { db, captured } = makeDb({ existing: null })
    await findOrCreateGroupConversation(db, 'a1', 'u1', 'k1', '120363@g.us', null)
    expect(captured.insertRow?.last_message_text).toBeNull()
  })

  it('race (23505): re-resolve por chat_id', async () => {
    const { db } = makeDb({
      existing: null,
      insertResult: { data: null, error: { code: '23505' } },
      racedRow: { id: 'grp-raced', is_group: true },
    })
    const r = await findOrCreateGroupConversation(db, 'a1', 'u1', 'k1', '120363@g.us', null)
    expect(r).toMatchObject({ id: 'grp-raced' })
  })

  it('erro não-unique: retorna null', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = makeDb({
      existing: null,
      insertResult: { data: null, error: { code: '42P01', message: 'boom' } },
    })
    const r = await findOrCreateGroupConversation(db, 'a1', 'u1', 'k1', '120363@g.us', null)
    expect(r).toBeNull()
    spy.mockRestore()
  })
})
