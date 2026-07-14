import { describe, expect, it } from 'vitest'
import { shouldAutoRedeem } from './should-auto-redeem'

describe('shouldAutoRedeem', () => {
  it('convite válido + sessão + não rodou → true (1 disparo)', () => {
    expect(shouldAutoRedeem({ ok: true }, 'user-1', false)).toBe(true)
  })

  it('já rodou (guard) → false — não repete no strict mode', () => {
    expect(shouldAutoRedeem({ ok: true }, 'user-1', true)).toBe(false)
  })

  it('sem sessão → false (deslogado)', () => {
    expect(shouldAutoRedeem({ ok: true }, null, false)).toBe(false)
    expect(shouldAutoRedeem({ ok: true }, undefined, false)).toBe(false)
  })

  it('peek used/inválido (ok:false) → false (idempotente)', () => {
    expect(shouldAutoRedeem({ ok: false }, 'user-1', false)).toBe(false)
  })

  it('peek ainda carregando (null) → false', () => {
    expect(shouldAutoRedeem(null, 'user-1', false)).toBe(false)
  })
})
