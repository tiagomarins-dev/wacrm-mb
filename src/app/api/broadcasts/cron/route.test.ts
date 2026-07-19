import { describe, expect, it, afterEach, vi } from 'vitest'

// Mock deps server-only para que importar a rota não toque rede/Supabase.
vi.mock('@/lib/broadcast/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/broadcast/send-engine', () => ({ drainBroadcast: vi.fn() }))

import { GET } from './route'

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/broadcasts/cron', { headers })
}

describe('GET /api/broadcasts/cron — auth', () => {
  const original = process.env.AUTOMATION_CRON_SECRET
  afterEach(() => {
    process.env.AUTOMATION_CRON_SECRET = original
  })

  it('503 quando o secret não está configurado', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const res = await GET(req())
    expect(res.status).toBe(503)
  })

  it('401 sem header', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'sekret-value'
    const res = await GET(req())
    expect(res.status).toBe(401)
  })

  it('401 com header errado', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'sekret-value'
    const res = await GET(req({ 'x-cron-secret': 'wrong' }))
    expect(res.status).toBe(401)
  })
})

describe('GET /api/broadcasts/cron — TTL de idempotência (mig 075)', () => {
  it('deleta eventos >24h best-effort e erro no delete não aborta o tick', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'sekret-value'
    const deletes: string[] = []
    // Admin fake: TTL falha; claim de scheduled retorna vazio → tick segue e responde 200.
    const { supabaseAdmin } = await import('@/lib/broadcast/admin-client')
    vi.mocked(supabaseAdmin).mockReturnValue({
      from(table: string) {
        if (table === 'broadcast_webhook_events') {
          return {
            delete: () => ({
              lt: async (_c: string, cutoff: string) => {
                deletes.push(cutoff)
                return { error: { message: 'boom' } }
              },
            }),
          }
        }
        // broadcasts: claim/drain vazios
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          lte: () => b,
          order: () => b,
          limit: () => b,
          update: () => b,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: [], error: null }),
        }
        return b
      },
    } as never)

    const res = await GET(req({ 'x-cron-secret': 'sekret-value' }))
    expect(res.status).toBe(200)
    expect(deletes).toHaveLength(1)
    // cutoff ~24h atrás
    const age = Date.now() - new Date(deletes[0]).getTime()
    expect(age).toBeGreaterThan(23.9 * 3600 * 1000)
    expect(age).toBeLessThan(24.1 * 3600 * 1000)
  })
})
