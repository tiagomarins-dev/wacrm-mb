import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { assignBroadcastAgentIfAny } from './assign-broadcast-agent'

// Builder fake encadeável (molde: broadcasts/cron/route.test.ts) — registra os
// filtros aplicados e resolve com o payload configurado.
interface Recorded {
  filters: [string, ...unknown[]][]
  update?: Record<string, unknown>
}

function makeDb(opts: {
  recipients: { data: unknown[] | null; error?: { message: string } | null }
  updateError?: { message: string } | null
}) {
  const calls: { recipients: Recorded; conversations: Recorded } = {
    recipients: { filters: [] },
    conversations: { filters: [] },
  }
  const db = {
    from(table: string) {
      const rec = table === 'broadcast_recipients' ? calls.recipients : calls.conversations
      const result =
        table === 'broadcast_recipients'
          ? { data: opts.recipients.data, error: opts.recipients.error ?? null }
          : { data: null, error: opts.updateError ?? null }
      const b: Record<string, unknown> = {
        select: () => b,
        update: (patch: Record<string, unknown>) => {
          rec.update = patch
          return b
        },
        eq: (...a: unknown[]) => {
          rec.filters.push(['eq', ...a])
          return b
        },
        not: (...a: unknown[]) => {
          rec.filters.push(['not', ...a])
          return b
        },
        in: (...a: unknown[]) => {
          rec.filters.push(['in', ...a])
          return b
        },
        gte: (...a: unknown[]) => {
          rec.filters.push(['gte', ...a])
          return b
        },
        is: (...a: unknown[]) => {
          rec.filters.push(['is', ...a])
          return b
        },
        order: () => b,
        limit: () => b,
        then: (resolve: (v: unknown) => void) => resolve(result),
      }
      return b
    },
  }
  return { db: db as unknown as SupabaseClient, calls }
}

const eligible = [
  {
    id: 'rec-1',
    sent_at: new Date().toISOString(),
    broadcasts: { account_id: 'acc-1', ai_profile_id: 'profile-1' },
  },
]

describe('assignBroadcastAgentIfAny', () => {
  it('atribui o perfil da campanha quando há recipient elegível', async () => {
    const { db, calls } = makeDb({ recipients: { data: eligible } })
    await assignBroadcastAgentIfAny(db, 'acc-1', 'contact-1', 'conv-1')

    expect(calls.conversations.update).toEqual({ assigned_agent_id: 'profile-1' })
    // Guarda anti-sobrescrita: o UPDATE só pega conversa órfã.
    expect(calls.conversations.filters).toContainEqual(['is', 'assigned_agent_id', null])
    // Tenant-scoping explícito no UPDATE (service-role bypassa RLS).
    expect(calls.conversations.filters).toContainEqual(['eq', 'account_id', 'acc-1'])
  })

  it('consulta com status enviáveis e janela de sent_at (não usa status=sent puro)', async () => {
    const { db, calls } = makeDb({ recipients: { data: eligible } })
    await assignBroadcastAgentIfAny(db, 'acc-1', 'contact-1', 'conv-1')

    // Recibos da Meta e o flag de reply mudam o status antes deste ponto.
    expect(calls.recipients.filters).toContainEqual([
      'in',
      'status',
      ['sent', 'delivered', 'read', 'replied'],
    ])
    const gte = calls.recipients.filters.find(([op]) => op === 'gte')
    expect(gte?.[1]).toBe('sent_at')
    // Janela ~7 dias.
    const age = Date.now() - new Date(gte?.[2] as string).getTime()
    expect(age).toBeGreaterThan(6.9 * 24 * 3600 * 1000)
    expect(age).toBeLessThan(7.1 * 24 * 3600 * 1000)
  })

  it('no-op quando não há recipient (sem broadcast com agente na janela)', async () => {
    const { db, calls } = makeDb({ recipients: { data: [] } })
    await assignBroadcastAgentIfAny(db, 'acc-1', 'contact-1', 'conv-1')
    expect(calls.conversations.update).toBeUndefined()
  })

  it('no-op quando o broadcast não tem ai_profile_id', async () => {
    const { db, calls } = makeDb({
      recipients: {
        data: [
          {
            id: 'rec-1',
            sent_at: new Date().toISOString(),
            broadcasts: { account_id: 'acc-1', ai_profile_id: null },
          },
        ],
      },
    })
    await assignBroadcastAgentIfAny(db, 'acc-1', 'contact-1', 'conv-1')
    expect(calls.conversations.update).toBeUndefined()
  })

  it('nunca lança: erro na query é engolido com log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db, calls } = makeDb({ recipients: { data: null, error: { message: 'boom' } } })
    await expect(
      assignBroadcastAgentIfAny(db, 'acc-1', 'contact-1', 'conv-1'),
    ).resolves.toBeUndefined()
    expect(calls.conversations.update).toBeUndefined()
    spy.mockRestore()
  })

  it('erro no UPDATE é logado e engolido', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { db } = makeDb({ recipients: { data: eligible }, updateError: { message: 'boom' } })
    await expect(
      assignBroadcastAgentIfAny(db, 'acc-1', 'contact-1', 'conv-1'),
    ).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
