import { describe, expect, it, afterEach, beforeEach } from 'vitest'
import { __resetRateLimitForTests } from '@/lib/rate-limit'
import { getClientIp, requirePlaygroundAuth, resolvePlaygroundAccountId } from './auth'

// Request sintética com headers arbitrários (mesmo padrão de broadcasts/cron/route.test.ts).
function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/playground-ruth/x', { headers })
}

describe('requirePlaygroundAuth', () => {
  const original = process.env.PLAYGROUND_RUTH_PASSWORD
  beforeEach(() => __resetRateLimitForTests())
  afterEach(() => {
    if (original === undefined) delete process.env.PLAYGROUND_RUTH_PASSWORD
    else process.env.PLAYGROUND_RUTH_PASSWORD = original
  })

  it('503 quando a env não está configurada', () => {
    delete process.env.PLAYGROUND_RUTH_PASSWORD
    const res = requirePlaygroundAuth(req())
    expect(res?.status).toBe(503)
  })

  it('401 sem header e 401 com senha errada', () => {
    process.env.PLAYGROUND_RUTH_PASSWORD = 'segredo-longo-de-teste-24ch'
    expect(requirePlaygroundAuth(req())?.status).toBe(401)
    expect(requirePlaygroundAuth(req({ 'x-playground-password': 'errada' }))?.status).toBe(401)
  })

  it('null (autorizado) com a senha certa', () => {
    process.env.PLAYGROUND_RUTH_PASSWORD = 'segredo-longo-de-teste-24ch'
    expect(requirePlaygroundAuth(req({ 'x-playground-password': 'segredo-longo-de-teste-24ch' }))).toBeNull()
  })

  it('429 na 31ª request do mesmo IP dentro da janela (antes do compare)', () => {
    process.env.PLAYGROUND_RUTH_PASSWORD = 'segredo-longo-de-teste-24ch'
    const headers = { 'x-forwarded-for': '10.0.0.9', 'x-playground-password': 'errada' }
    for (let i = 0; i < 30; i++) {
      expect(requirePlaygroundAuth(req(headers))?.status).toBe(401)
    }
    // 31ª: bucket estourado → 429 mesmo que a senha agora esteja CERTA
    // (fecha o oráculo: sem compare após o estouro).
    expect(
      requirePlaygroundAuth(
        req({ 'x-forwarded-for': '10.0.0.9', 'x-playground-password': 'segredo-longo-de-teste-24ch' }),
      )?.status,
    ).toBe(429)
  })
})

describe('getClientIp', () => {
  it('x-forwarded-for (primeiro hop) > x-real-ip > unknown', () => {
    expect(getClientIp(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4')
    expect(getClientIp(req({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9')
    expect(getClientIp(req())).toBe('unknown')
  })
})

describe('resolvePlaygroundAccountId', () => {
  const original = process.env.PLAYGROUND_RUTH_ACCOUNT_ID
  afterEach(() => {
    if (original === undefined) delete process.env.PLAYGROUND_RUTH_ACCOUNT_ID
    else process.env.PLAYGROUND_RUTH_ACCOUNT_ID = original
  })

  // db fake mínimo: só o caminho from('ai_profiles').select('account_id').
  const dbWith = (rows: { account_id: string }[]) =>
    ({ from: () => ({ select: () => Promise.resolve({ data: rows, error: null }) }) }) as never

  it('env âncora vence a detecção', async () => {
    process.env.PLAYGROUND_RUTH_ACCOUNT_ID = 'acc-env'
    const r = await resolvePlaygroundAccountId(dbWith([{ account_id: 'acc-1' }]))
    expect(r).toEqual({ accountId: 'acc-env' })
  })

  it('exatamente 1 conta distinta → usa', async () => {
    delete process.env.PLAYGROUND_RUTH_ACCOUNT_ID
    const r = await resolvePlaygroundAccountId(
      dbWith([{ account_id: 'acc-1' }, { account_id: 'acc-1' }]),
    )
    expect(r).toEqual({ accountId: 'acc-1' })
  })

  it('0 contas → 404', async () => {
    delete process.env.PLAYGROUND_RUTH_ACCOUNT_ID
    const r = await resolvePlaygroundAccountId(dbWith([]))
    expect('response' in r && r.response.status).toBe(404)
  })

  it('2 contas sem env → 409 (falha fechado)', async () => {
    delete process.env.PLAYGROUND_RUTH_ACCOUNT_ID
    const r = await resolvePlaygroundAccountId(
      dbWith([{ account_id: 'acc-1' }, { account_id: 'acc-2' }]),
    )
    expect('response' in r && r.response.status).toBe(409)
  })
})
