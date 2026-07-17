import { describe, expect, it } from 'vitest'
import { parseClassification } from './openrouter'

// Parse PURO da classificação completa (F2). Espelha intent-parse.test.ts.
describe('parseClassification', () => {
  it('happy suporte: intent + motivo + flags', () => {
    const r = parseClassification(
      '{"intent":"suporte","motivo":"financeiro","loss_reason":null,"flags":{"sentimento_negativo":true,"oportunidade_venda":false}}',
    )
    expect(r).toEqual({
      intent: 'suporte',
      motivo: 'financeiro',
      loss_reason: null,
      flags: { sentimento_negativo: true, oportunidade_venda: false },
    })
  })

  it('happy vendas: loss_reason preenchido', () => {
    const r = parseClassification(
      '{"intent":"vendas","motivo":null,"loss_reason":"preco","flags":{"sentimento_negativo":false,"oportunidade_venda":false}}',
    )
    expect(r?.intent).toBe('vendas')
    expect(r?.loss_reason).toBe('preco')
    expect(r?.motivo).toBeNull()
  })

  it('JSON malformado → null', () => {
    expect(parseClassification('não é json')).toBeNull()
    expect(parseClassification('')).toBeNull()
    expect(parseClassification(null)).toBeNull()
  })

  it('intent fora do enum → null (degrada tudo)', () => {
    expect(parseClassification('{"intent":"marketing"}')).toBeNull()
  })

  it('cross-field: vendas com motivo preenchido → motivo null (e simétrico)', () => {
    const v = parseClassification('{"intent":"vendas","motivo":"financeiro","loss_reason":"preco","flags":{}}')
    expect(v?.motivo).toBeNull()
    expect(v?.loss_reason).toBe('preco')
    const s = parseClassification('{"intent":"suporte","motivo":"erro_bug","loss_reason":"preco","flags":{}}')
    expect(s?.loss_reason).toBeNull()
    expect(s?.motivo).toBe('erro_bug')
  })

  it('flags não-boolean (string/número/objeto) → coagidas a false; chaves extras dropadas', () => {
    const r = parseClassification(
      '{"intent":"outro","flags":{"sentimento_negativo":"true","oportunidade_venda":1,"hack":true}}',
    )
    expect(r?.flags).toEqual({ sentimento_negativo: false, oportunidade_venda: false })
  })

  it('campo inválido isolado não derruba o resto', () => {
    const r = parseClassification('{"intent":"suporte","motivo":"inexistente","flags":{"sentimento_negativo":true}}')
    expect(r?.intent).toBe('suporte')
    expect(r?.motivo).toBeNull()
    expect(r?.flags.sentimento_negativo).toBe(true)
  })

  it('flags ausentes → objeto com falses', () => {
    const r = parseClassification('{"intent":"outro"}')
    expect(r?.flags).toEqual({ sentimento_negativo: false, oportunidade_venda: false })
  })
})
