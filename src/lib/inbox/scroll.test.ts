import { describe, expect, it } from 'vitest'
import { isNearBottom, NEAR_BOTTOM_PX } from './scroll'

// Monta um "elemento" estrutural (sh/st/ch). distância = sh - st - ch.
const el = (sh: number, st: number, ch: number) => ({ scrollHeight: sh, scrollTop: st, clientHeight: ch })

describe('isNearBottom', () => {
  it('a 79px do fim → true (dentro do limiar 80)', () => {
    expect(isNearBottom(el(1000, 921, 0))).toBe(true) // 1000-921-0 = 79
  })
  it('a 80px do fim → false (limiar exclusivo)', () => {
    expect(isNearBottom(el(1000, 920, 0))).toBe(false) // = 80
  })
  it('a 81px do fim → false', () => {
    expect(isNearBottom(el(1000, 919, 0))).toBe(false) // = 81
  })
  it('conteúdo menor que a viewport → true', () => {
    expect(isNearBottom(el(300, 0, 600))).toBe(true) // -300
  })
  it('topo de histórico longo → false', () => {
    expect(isNearBottom(el(6000, 0, 600))).toBe(false) // 5400
  })
  it('cabe exato (sh === ch) → true', () => {
    expect(isNearBottom(el(600, 0, 600))).toBe(true) // 0
  })
  it('respeita threshold custom', () => {
    expect(isNearBottom(el(1000, 700, 0), 400)).toBe(true) // dist 300 < 400
    expect(isNearBottom(el(1000, 700, 0), 200)).toBe(false) // dist 300 >= 200
  })
  it('NEAR_BOTTOM_PX = 80', () => {
    expect(NEAR_BOTTOM_PX).toBe(80)
  })
})
