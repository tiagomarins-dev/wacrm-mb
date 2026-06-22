import { describe, expect, it } from 'vitest'
import { applyGuardrail, hasForbidden } from './guardrail'

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
