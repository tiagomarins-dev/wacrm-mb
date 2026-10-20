import { describe, expect, it } from 'vitest'
import { deliveryErrorKey, deliveryErrorTitle, describeDeliveryError } from './delivery-error'

describe('deliveryErrorKey', () => {
  it('código conhecido vira chave do dicionário', () => {
    expect(deliveryErrorKey(131049)).toBe('deliveryError.131049')
    expect(deliveryErrorKey(131026)).toBe('deliveryError.131026')
  })

  it('código desconhecido ou ausente devolve null', () => {
    expect(deliveryErrorKey(999)).toBeNull()
    expect(deliveryErrorKey(null)).toBeNull()
    expect(deliveryErrorKey(undefined)).toBeNull()
  })
})

describe('deliveryErrorTitle', () => {
  it('pega o título do primeiro erro', () => {
    expect(deliveryErrorTitle('130472 — User is part of an experiment — detalhe | 1 — outro')).toBe('User is part of an experiment')
  })

  it('sem título usa o primeiro trecho; vazio devolve null', () => {
    expect(deliveryErrorTitle('130472')).toBe('130472')
    expect(deliveryErrorTitle(null)).toBeNull()
    expect(deliveryErrorTitle('')).toBeNull()
  })
})

describe('describeDeliveryError', () => {
  const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${JSON.stringify(opts)}` : key)

  it('código conhecido usa o texto próprio', () => {
    expect(describeDeliveryError(t, { error_code: 131049, error_message: '131049 — x' })).toBe('deliveryError.131049')
  })

  it('código desconhecido mostra código e título da Meta', () => {
    expect(describeDeliveryError(t, { error_code: 130472, error_message: '130472 — User is part of an experiment' }))
      .toBe('deliveryErrorGeneric:{"code":130472,"title":"User is part of an experiment"}')
  })
})
