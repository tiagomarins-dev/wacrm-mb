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
