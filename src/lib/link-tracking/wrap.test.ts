import { describe, expect, it, vi, beforeEach } from 'vitest'

// getSiteUrl mockável por teste (retorno controlado via holder hoisted).
const h = vi.hoisted(() => ({ base: 'https://crm.test' as string | undefined }))
vi.mock('@/lib/site-url', () => ({ getSiteUrl: () => h.base }))

import { wrapTrackableLinks } from './wrap'

// Fake db: captura inserts em link_tokens (espelha token.test.ts).
 
function makeDb() {
  const inserts: Record<string, unknown>[] = []
  const builder = () => {
    const op = { type: 'select', payload: null as unknown }
    const resolve = () => {
      if (op.type === 'insert') {
        inserts.push(op.payload as Record<string, unknown>)
        return { data: { id: 'x' }, error: null }
      }
      return { data: null, error: null }
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

const ARGS = { accountId: 'acc-1', contactId: 'contact-1' }

beforeEach(() => {
  h.base = 'https://crm.test'
})

describe('wrapTrackableLinks', () => {
  it('text falsy → devolve igual, sem insert', async () => {
    const { db, inserts } = makeDb()
    expect(await wrapTrackableLinks(db, '', ARGS)).toBe('')
    expect(await wrapTrackableLinks(db, null, ARGS)).toBeNull()
    expect(inserts).toHaveLength(0)
  })

  it('getSiteUrl ausente → devolve original, sem insert', async () => {
    h.base = undefined
    const { db, inserts } = makeDb()
    const text = 'olha https://exemplo.com/p'
    expect(await wrapTrackableLinks(db, text, ARGS)).toBe(text)
    expect(inserts).toHaveLength(0)
  })

  it('1 URL → substitui por /r/<token> e grava source=manual', async () => {
    const { db, inserts } = makeDb()
    const out = await wrapTrackableLinks(db, 'olha https://exemplo.com/p', ARGS)
    expect(out).toMatch(/https:\/\/crm\.test\/r\/[a-f0-9]{32}$/)
    expect(inserts).toHaveLength(1)
    expect(inserts[0].url).toBe('https://exemplo.com/p')
    expect(inserts[0].source).toBe('manual')
  })

  it('URL já /r/ → não re-wrapa', async () => {
    const { db, inserts } = makeDb()
    const token = 'a'.repeat(32)
    const text = `veja https://crm.test/r/${token}`
    const out = await wrapTrackableLinks(db, text, ARGS)
    expect(out).toBe(text)
    expect(inserts).toHaveLength(0)
  })

  it('2 URLs → 2 tokens, posições corretas', async () => {
    const { db, inserts } = makeDb()
    const out = await wrapTrackableLinks(db, 'a https://x.com b https://y.io/z c', ARGS)
    expect(inserts).toHaveLength(2)
    expect(out).toMatch(/^a https:\/\/crm\.test\/r\/[a-f0-9]{32} b https:\/\/crm\.test\/r\/[a-f0-9]{32} c$/)
  })

  it('sem URL → devolve original, sem insert', async () => {
    const { db, inserts } = makeDb()
    expect(await wrapTrackableLinks(db, 'sem link', ARGS)).toBe('sem link')
    expect(inserts).toHaveLength(0)
  })
})
