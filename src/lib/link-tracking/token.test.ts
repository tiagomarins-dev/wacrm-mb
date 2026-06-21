import { describe, expect, it } from 'vitest'
import { createLinkToken, consumeLinkToken } from './token'

const NOW = 1_750_000_000_000

// Fake db: captura inserts em link_tokens e devolve uma linha canned no select.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(row: any) {
  const inserts: Record<string, unknown>[] = []
  const builder = () => {
    const op = { type: 'select', payload: null as unknown }
    const resolve = () => {
      if (op.type === 'insert') {
        inserts.push(op.payload as Record<string, unknown>)
        return { data: { id: 'x' }, error: null }
      }
      return { data: row, error: null }
    }
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((op.type = 'insert'), (op.payload = p), b),
      eq: () => b,
      maybeSingle: () => Promise.resolve(resolve()),
      then: (f: (v: unknown) => unknown) => Promise.resolve(resolve()).then(f),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: () => builder() } as any, inserts }
}

const args = {
  account_id: 'acc-1',
  flow_id: 'flow-1',
  run_id: 'run-1',
  node_key: 'wait_link',
  contact_id: 'contact-1',
  url: 'https://example.com/x',
}

describe('createLinkToken', () => {
  it('insere a linha e devolve id hex de 32 chars', async () => {
    const { db, inserts } = makeDb(null)
    const id = await createLinkToken(db, args, NOW)
    expect(id).toMatch(/^[0-9a-f]{32}$/)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].url).toBe('https://example.com/x')
    expect(inserts[0].run_id).toBe('run-1')
  })

  it('url não-http → lança', async () => {
    const { db } = makeDb(null)
    await expect(
      createLinkToken(db, { ...args, url: 'javascript:alert(1)' }, NOW),
    ).rejects.toThrow(/http/)
  })
})

describe('consumeLinkToken', () => {
  it('linha válida → devolve payload', async () => {
    const { db } = makeDb({
      flow_id: 'flow-1',
      run_id: 'run-1',
      node_key: 'wait_link',
      contact_id: 'contact-1',
      url: 'https://example.com/x',
      expires_at: new Date(NOW + 1000).toISOString(),
    })
    const p = await consumeLinkToken(db, 'abc', NOW)
    expect(p?.run_id).toBe('run-1')
    expect(p?.url).toBe('https://example.com/x')
  })

  it('linha inexistente → null', async () => {
    const { db } = makeDb(null)
    expect(await consumeLinkToken(db, 'abc', NOW)).toBeNull()
  })

  it('expirada → null', async () => {
    const { db } = makeDb({
      flow_id: 'f',
      run_id: 'r',
      node_key: 'n',
      contact_id: null,
      url: 'https://example.com/x',
      expires_at: new Date(NOW - 1000).toISOString(),
    })
    expect(await consumeLinkToken(db, 'abc', NOW)).toBeNull()
  })

  it('id vazio → null', async () => {
    const { db } = makeDb(null)
    expect(await consumeLinkToken(db, '', NOW)).toBeNull()
  })
})
