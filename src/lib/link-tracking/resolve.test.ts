import { describe, expect, it } from 'vitest'
import { resolveTokens } from './resolve'

// Fake db: filtra um store por in(ids) + eq(account_id), igual à query real.
function makeDb(store: { id: string; url: string; account_id: string }[]) {
  function makeQuery() {
    let ids: string[] = []
    let account = ''
    const q: Record<string, unknown> = {
      select: () => q,
      in: (_c: string, v: string[]) => ((ids = v), q),
      eq: (_c: string, v: string) => ((account = v), q),
      then: (f: (r: unknown) => unknown) =>
        Promise.resolve({
          data: store.filter((r) => ids.includes(r.id) && r.account_id === account),
          error: null,
        }).then(f),
    }
    return q
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => makeQuery() } as any
}

const STORE = [
  { id: 'a'.repeat(32), url: 'https://real.com/1', account_id: 'acc-1' },
  { id: 'b'.repeat(32), url: 'https://real.com/2', account_id: 'acc-2' },
]

describe('resolveTokens', () => {
  it('lista vazia → {}', async () => {
    expect(await resolveTokens(makeDb(STORE), 'acc-1', [])).toEqual({})
  })

  it('happy → { token: url }', async () => {
    const map = await resolveTokens(makeDb(STORE), 'acc-1', ['a'.repeat(32)])
    expect(map['a'.repeat(32)]).toBe('https://real.com/1')
  })

  it('isolamento: token de outra conta ausente', async () => {
    const map = await resolveTokens(makeDb(STORE), 'acc-1', ['a'.repeat(32), 'b'.repeat(32)])
    expect(map['a'.repeat(32)]).toBe('https://real.com/1')
    expect(map['b'.repeat(32)]).toBeUndefined()
  })
})
