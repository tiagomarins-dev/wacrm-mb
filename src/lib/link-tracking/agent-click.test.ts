import { describe, expect, it } from 'vitest'
import { recordAgentClick } from './agent-click'
import type { ConsumedToken } from './token'

// Fake db: devolve a connection do contato no select e captura o insert
// em link_clicks. Estilo de token.test.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(contactRow: any) {
  const inserts: { table: string; payload: Record<string, unknown> }[] = []
  const builder = (table: string) => {
    const op = { type: 'select' as 'select' | 'insert', payload: null as unknown }
    const result = () => {
      if (op.type === 'insert') {
        inserts.push({ table, payload: op.payload as Record<string, unknown> })
        return { data: null, error: null }
      }
      return { data: contactRow, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((op.type = 'insert'), (op.payload = p), Promise.resolve(result())),
      eq: () => b,
      maybeSingle: () => Promise.resolve(result()),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: (t: string) => builder(t) } as any, inserts }
}

const payload: ConsumedToken = {
  account_id: 'acc-1',
  source: 'agent',
  flow_id: null as unknown as string,
  run_id: null as unknown as string,
  node_key: 'agent',
  contact_id: 'contact-1',
  url: 'https://pay.hotmart.com/x',
}

describe('recordAgentClick', () => {
  it('insere link_clicks com source=agent, flow_run_id null e connection do contato', async () => {
    const { db, inserts } = makeDb({ connection_id: 'conn-9' })
    await recordAgentClick(db, payload, 'Mozilla/5.0')
    expect(inserts).toHaveLength(1)
    const p = inserts[0].payload
    expect(p.source).toBe('agent')
    expect(p.flow_run_id).toBeNull()
    expect(p.connection_id).toBe('conn-9')
    expect(p.target_url).toBe('https://pay.hotmart.com/x')
    expect(p.is_sale).toBe(false)
    expect(p.account_id).toBe('acc-1')
  })

  it('contato sem connection → grava connection_id null (coluna é nullable)', async () => {
    const { db, inserts } = makeDb(null)
    await recordAgentClick(db, { ...payload, contact_id: null }, null)
    expect(inserts[0].payload.connection_id).toBeNull()
  })
})
