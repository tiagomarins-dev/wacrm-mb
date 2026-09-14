// ============================================================
// Testa GET /api/opportunities/cron por invocação direta do handler. Mocka a lib de
// oportunidades; cobre auth (503/401), repasse do ?dry e o 500 sem vazar detalhe.
// ============================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ runOpportunityTagSync: vi.fn() }))

vi.mock('@/lib/opportunities/tag-sync', () => ({ runOpportunityTagSync: h.runOpportunityTagSync }))

const SECRET = 'segredo-de-teste'

function call(secret?: string, query = '') {
  return new Request(`http://localhost/api/opportunities/cron${query}`, {
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

describe('GET /api/opportunities/cron', () => {
  beforeEach(() => {
    h.runOpportunityTagSync.mockReset()
    h.runOpportunityTagSync.mockResolvedValue({ accounts: [{ account_id: 'a1', tagged: 1 }] })
    process.env.AUTOMATION_CRON_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.AUTOMATION_CRON_SECRET
    vi.restoreAllMocks()
  })

  it('503 quando o secret não está configurado', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(503)
    expect(h.runOpportunityTagSync).not.toHaveBeenCalled()
  })

  it('401 com secret errado ou de tamanho diferente', async () => {
    const { GET } = await import('./route')
    expect((await GET(call('segredo-de-testx'))).status).toBe(401)
    expect((await GET(call('curto'))).status).toBe(401)
    expect((await GET(call())).status).toBe(401)
    expect(h.runOpportunityTagSync).not.toHaveBeenCalled()
  })

  it('200 repassa o resultado e roda com dry=false', async () => {
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accounts: [{ account_id: 'a1', tagged: 1 }] })
    expect(h.runOpportunityTagSync).toHaveBeenCalledWith({ dry: false })
  })

  it('?dry=1 e ?dry=true simulam', async () => {
    const { GET } = await import('./route')
    await GET(call(SECRET, '?dry=1'))
    await GET(call(SECRET, '?dry=true'))
    expect(h.runOpportunityTagSync).toHaveBeenNthCalledWith(1, { dry: true })
    expect(h.runOpportunityTagSync).toHaveBeenNthCalledWith(2, { dry: true })
  })

  it('500 genérico em falha, sem a mensagem no corpo', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.runOpportunityTagSync.mockRejectedValue(new Error('contacts insert failed'))
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'opportunities sync failed' })
    expect(spy).toHaveBeenCalledWith('[opportunities/cron] failed:', 'contacts insert failed')
  })
})
