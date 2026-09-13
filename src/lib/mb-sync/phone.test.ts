import { describe, expect, it } from 'vitest'
import { phoneKeys, toCanonicalBr } from './phone'

describe('toCanonicalBr', () => {
  it('mantém 55+DDD+número (13 e 12 dígitos)', () => {
    expect(toCanonicalBr('5521987654321')).toBe('5521987654321')
    expect(toCanonicalBr('552187654321')).toBe('552187654321')
  })

  it('prefixa 55 em DDD+número sem DDI (11 e 10 dígitos)', () => {
    expect(toCanonicalBr('21987654321')).toBe('5521987654321')
    expect(toCanonicalBr('2187654321')).toBe('552187654321')
  })

  it('ignora máscara', () => {
    expect(toCanonicalBr('+55 (21) 98765-4321')).toBe('5521987654321')
  })

  it('rejeita zero de tronco, tamanhos inválidos e vazio', () => {
    expect(toCanonicalBr('021987654321')).toBeNull()
    expect(toCanonicalBr('0219876543')).toBeNull()
    expect(toCanonicalBr('123456789')).toBeNull()
    expect(toCanonicalBr('37063949836000')).toBeNull()
    expect(toCanonicalBr('')).toBeNull()
    expect(toCanonicalBr(null)).toBeNull()
    expect(toCanonicalBr(undefined)).toBeNull()
  })
})

describe('phoneKeys', () => {
  it('celular com 9: exata → sem 9 → sem 55 → sem 55 e sem 9', () => {
    expect(phoneKeys('5521987654321')).toEqual([
      '5521987654321',
      '552187654321',
      '21987654321',
      '2187654321',
    ])
  })

  it('celular sem 9: gera a variante com 9', () => {
    expect(phoneKeys('552187654321')).toEqual([
      '552187654321',
      '5521987654321',
      '2187654321',
      '21987654321',
    ])
  })

  it('número sem variante do 9º dígito gera só exata e sem 55', () => {
    const keys = phoneKeys('5521812345678')
    expect(keys).toEqual(['5521812345678', '21812345678'])
  })

  it('nunca gera chave com menos de 10 dígitos', () => {
    for (const k of [...phoneKeys('5521987654321'), ...phoneKeys('552187654321')]) {
      expect(k.length).toBeGreaterThanOrEqual(10)
    }
  })
})
