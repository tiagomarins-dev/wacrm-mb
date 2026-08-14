import { describe, expect, it } from 'vitest'
import { formatTokens, formatUsd, toNumber } from './ai-cost'

describe('toNumber', () => {
  it('numérico do Postgres (string) vira número', () => {
    expect(toNumber('43.6463')).toBeCloseTo(43.6463)
  })
  it('nulo/undefined/lixo → 0 (não propaga NaN pros cards)', () => {
    expect(toNumber(null)).toBe(0)
    expect(toNumber(undefined)).toBe(0)
    expect(toNumber('abc')).toBe(0)
  })
})

describe('formatUsd', () => {
  it('custo de turno (< 1 centavo) mantém 4 casas', () => {
    expect(formatUsd('0.0059')).toBe('US$ 0,0059')
  })
  it('custo de conversa usa 3 casas', () => {
    expect(formatUsd(0.1732)).toBe('US$ 0,173')
  })
  it('total do período lê como dinheiro, 2 casas', () => {
    expect(formatUsd('43.6463')).toBe('US$ 43,65')
  })
  it('zero e nulo não viram NaN', () => {
    expect(formatUsd(0)).toBe('US$ 0,00')
    expect(formatUsd(null)).toBe('US$ 0,00')
  })
})

describe('formatTokens', () => {
  it('milhões abreviam', () => {
    expect(formatTokens(13_973_705)).toBe('14,0M')
  })
  it('milhares abreviam', () => {
    expect(formatTokens(220_768)).toBe('221k')
  })
  it('abaixo de mil sai cru', () => {
    expect(formatTokens(940)).toBe('940')
  })
})
