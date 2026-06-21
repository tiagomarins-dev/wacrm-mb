import { describe, expect, it } from 'vitest'
import { computeScore, classify, DEFAULT_WEIGHTS } from './score'

describe('computeScore', () => {
  it('link de venda vale 2x o link normal', () => {
    const sale = computeScore({ msgs: 0, buttons: 0, links: 1, sales: 1 })
    const normal = computeScore({ msgs: 0, buttons: 0, links: 1, sales: 0 })
    expect(normal).toBe(5) // link_weight
    expect(sale).toBe(10) // round(5*2)
    expect(sale).toBe(2 * normal)
  })

  it('soma ponderada de msgs + botões + cliques (1 de venda)', () => {
    // 2*1 + 1*3 + (3-1)*5 + 1*10 = 2 + 3 + 10 + 10 = 25
    expect(computeScore({ msgs: 2, buttons: 1, links: 3, sales: 1 })).toBe(25)
  })

  it('zero interação → 0', () => {
    expect(computeScore({ msgs: 0, buttons: 0, links: 0, sales: 0 })).toBe(0)
  })

  it('respeita pesos customizados', () => {
    const w = { msg: 2, button: 4, link: 6, saleMultiplier: 3 }
    // 1*2 + 0 + (0-0)*6 + 0 = 2 ; venda: 1*round(6*3)=18
    expect(computeScore({ msgs: 1, buttons: 0, links: 0, sales: 0 }, w)).toBe(2)
    expect(computeScore({ msgs: 0, buttons: 0, links: 1, sales: 1 }, w)).toBe(18)
  })

  it('usa DEFAULT_WEIGHTS quando omitido', () => {
    expect(computeScore({ msgs: 1, buttons: 0, links: 0, sales: 0 })).toBe(DEFAULT_WEIGHTS.msg)
  })
})

describe('classify', () => {
  it('quente no/acima do limiar hot', () => {
    expect(classify(50, 50, 20)).toBe('quente')
    expect(classify(80, 50, 20)).toBe('quente')
  })
  it('morno entre warm e hot', () => {
    expect(classify(20, 50, 20)).toBe('morno')
    expect(classify(49, 50, 20)).toBe('morno')
  })
  it('frio abaixo de warm', () => {
    expect(classify(19, 50, 20)).toBe('frio')
    expect(classify(0, 50, 20)).toBe('frio')
  })
})
