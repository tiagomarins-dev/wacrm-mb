// ============================================================
// Testa GET /api/mb-sync/cron por invocação direta do handler. Mocka a lib de
// sincronização; cobre auth (503/401), repasse do ?dry e o 500 sem vazar detalhe.
// ============================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ runMbClassSync: vi.fn() }))

vi.mock('@/lib/mb-sync/sync', () => ({ runMbClassSync: h.runMbClassSync }))

const SECRET = 'segredo-de-teste'

function call(secret?: string, query = '') {
  return new Request(`http://localhost/api/mb-sync/cron${query}`, {
    headers: secret ? { 'x-cron-secret': secret } : {},
  })
}

describe('GET /api/mb-sync/cron', () => {
  beforeEach(() => {
    h.runMbClassSync.mockReset()
    h.runMbClassSync.mockResolvedValue({ tags: [{ tag_id: 't1', added: 1 }] })
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
    expect(h.runMbClassSync).not.toHaveBeenCalled()
  })

  it('401 com secret errado ou de tamanho diferente', async () => {
    const { GET } = await import('./route')
    expect((await GET(call('segredo-de-testx'))).status).toBe(401)
    expect((await GET(call('curto'))).status).toBe(401)
    expect((await GET(call())).status).toBe(401)
    expect(h.runMbClassSync).not.toHaveBeenCalled()
  })

  it('200 repassa o resultado e roda com dry=false', async () => {
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ tags: [{ tag_id: 't1', added: 1 }] })
    expect(h.runMbClassSync).toHaveBeenCalledWith({ dry: false })
  })

  it('?dry=1 e ?dry=true simulam', async () => {
    const { GET } = await import('./route')
    await GET(call(SECRET, '?dry=1'))
    await GET(call(SECRET, '?dry=true'))
    expect(h.runMbClassSync).toHaveBeenNthCalledWith(1, { dry: true })
    expect(h.runMbClassSync).toHaveBeenNthCalledWith(2, { dry: true })
  })

  it('500 genérico em falha, sem a mensagem no corpo', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.runMbClassSync.mockRejectedValue(new Error('contacts insert failed'))
    const { GET } = await import('./route')
    const res = await GET(call(SECRET))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'mb sync failed' })
    expect(spy).toHaveBeenCalledWith('[mb-sync/cron] failed:', 'contacts insert failed')
  })
})
