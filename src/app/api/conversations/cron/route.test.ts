// ============================================================
// Testa GET /api/conversations/cron por invocação direta do handler.
// Mocka o admin client (só .rpc). Cobre auth (503/401), o disparo dos DOIS
// sweeps (desatribuir + fechar) e a independência entre eles: falha de um não
// impede o outro; 500 só quando os dois falham.
// ============================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  fail: new Set<string>(),
  data: { unassign_inactive_conversations: 3, close_inactive_conversations: 7 } as Record<string, number>,
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string) => {
      h.calls.push(fn)
      if (h.fail.has(fn)) return { data: null, error: { message: `${fn} boom` } }
      return { data: h.data[fn] ?? 0, error: null }
    },
  }),
}))

const SECRET = 'segredo-de-teste'

function call(secret?: string) {
  return new Request('http://localhost/api/conversations/cron', {
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

describe('GET /api/conversations/cron', () => {
  beforeEach(() => {
    h.calls = []
    h.fail = new Set()
    process.env.AUTOMATION_CRON_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.AUTOMATION_CRON_SECRET
    vi.resetModules()
  })

  it('503 quando o secret não está configurado', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(503)
    expect(h.calls).toEqual([])
  })

  it('401 com secret errado — e não roda sweep nenhum', async () => {
    const { GET } = await import('./route')
    const res = await GET(call('errado'))
    expect(res.status).toBe(401)
    expect(h.calls).toEqual([])
  })

  it('roda os dois sweeps e devolve as contagens', async () => {
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ released: 3, closed: 7 })
    expect(h.calls).toEqual(['unassign_inactive_conversations', 'close_inactive_conversations'])
  })

  it('falha da desatribuição não impede o fechamento', async () => {
    h.fail.add('unassign_inactive_conversations')
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ released: 0, closed: 7 })
    expect(h.calls).toContain('close_inactive_conversations')
  })

  it('falha do fechamento não impede a desatribuição', async () => {
    h.fail.add('close_inactive_conversations')
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ released: 3, closed: 0 })
  })

  it('500 quando os dois sweeps falham', async () => {
    h.fail.add('unassign_inactive_conversations')
    h.fail.add('close_inactive_conversations')
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(500)
  })
})
