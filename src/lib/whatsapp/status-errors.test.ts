import { describe, expect, it } from 'vitest'
import { firstStatusErrorCode, formatStatusErrors } from './status-errors'

describe('formatStatusErrors', () => {
  it('junta código, título, mensagem e detalhe', () => {
    expect(
      formatStatusErrors([
        { code: 131049, title: 'This message was not delivered', message: 'healthy ecosystem', error_data: { details: 'limite' } },
      ]),
    ).toBe('131049 — This message was not delivered — healthy ecosystem — limite')
  })

  it('separa vários erros com barra vertical', () => {
    expect(formatStatusErrors([{ code: 1, title: 'a' }, { code: 2, title: 'b' }])).toBe('1 — a | 2 — b')
  })

  it('sem erros devolve null', () => {
    expect(formatStatusErrors(undefined)).toBeNull()
    expect(formatStatusErrors([])).toBeNull()
    expect(formatStatusErrors([{}])).toBeNull()
  })

  it('corta em 500 caracteres', () => {
    expect(formatStatusErrors([{ code: 1, message: 'x'.repeat(900) }])!.length).toBe(500)
  })
})

describe('firstStatusErrorCode', () => {
  it('devolve o código do primeiro erro', () => {
    expect(firstStatusErrorCode([{ code: 131026 }, { code: 1 }])).toBe(131026)
  })

  it('sem código inteiro devolve null', () => {
    expect(firstStatusErrorCode(undefined)).toBeNull()
    expect(firstStatusErrorCode([{ title: 'x' }])).toBeNull()
  })
})
