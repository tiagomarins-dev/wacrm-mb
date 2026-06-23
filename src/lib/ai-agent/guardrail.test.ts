import { describe, expect, it } from 'vitest'
import { applyGuardrail, hasForbidden, stripMarkdown } from './guardrail'

describe('stripMarkdown', () => {
  it('remove negrito ** e *', () => {
    expect(stripMarkdown('**Combo Brasil** e *Descrição:* aqui')).toBe('Combo Brasil e Descrição: aqui')
  })
  it('remove marcadores de lista (1. e -)', () => {
    expect(stripMarkdown('1. Combo Brasil\n- Descrição: x')).toBe('Combo Brasil\nDescrição: x')
  })
  it('link markdown vira texto + url', () => {
    expect(stripMarkdown('veja [aqui](https://x.com)')).toBe('veja aqui https://x.com')
  })
  it('texto limpo passa igual', () => {
    expect(stripMarkdown('12x de R$ 96,24')).toBe('12x de R$ 96,24')
  })
})

describe('applyGuardrail', () => {
  it('troca vocabulário comercial frio pelo da Milla', () => {
    expect(applyGuardrail('Você pode comprar agora')).toBe('Você pode garantir agora')
    expect(applyGuardrail('o preço é ótimo')).toBe('o valor da matrícula é ótimo')
    expect(applyGuardrail('faça o investimento')).toBe('faça o condição')
  })

  it('preserva maiúscula inicial na troca', () => {
    expect(applyGuardrail('Compra liberada')).toBe('Matrícula liberada')
  })

  it('remove travessão → vírgula', () => {
    expect(applyGuardrail('O bonde provou — com 7 nota mil — que funciona')).toBe(
      'O bonde provou, com 7 nota mil, que funciona',
    )
  })

  it('texto já limpo passa inalterado', () => {
    const t = 'Oi, Tiago! Vamos garantir sua vaga?'
    expect(applyGuardrail(t)).toBe(t)
  })
})

describe('hasForbidden', () => {
  it('detecta termo proibido e travessão', () => {
    expect(hasForbidden('quero comprar')).toBe(true)
    expect(hasForbidden('texto — com travessão')).toBe(true)
  })
  it('texto limpo → false', () => {
    expect(hasForbidden('garanta sua vaga no curso')).toBe(false)
  })
})
