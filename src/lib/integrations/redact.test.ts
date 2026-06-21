import { describe, expect, it } from 'vitest'
import { redactPII } from './redact'

describe('redactPII', () => {
  it('mascara email mantendo a 1ª letra e o domínio', () => {
    expect(redactPII('me chama no tiago@example.com por favor')).toBe(
      'me chama no t***@example.com por favor',
    )
  })

  it('mascara telefone', () => {
    expect(redactPII('meu zap é +55 21 98786-8395')).toBe('meu zap é [telefone]')
  })

  it('não mexe em texto sem PII', () => {
    expect(redactPII('a plataforma está com erro no login')).toBe(
      'a plataforma está com erro no login',
    )
  })

  it('não mascara números curtos', () => {
    expect(redactPII('tenho 2 problemas')).toBe('tenho 2 problemas')
  })
})
