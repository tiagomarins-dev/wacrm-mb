import { describe, expect, it } from 'vitest'
import {
  collectPayloadKeys,
  materializePayloadVariables,
  resolveVariables,
  extrairPrimeiroNome,
  valorDoCampo,
  type VariableMapping,
} from './variables'
import type { Contact } from '@/types'

const contact = {
  id: 'c1',
  phone: '5521999999999',
  name: 'Ana',
  email: 'ana@example.com',
  company: 'Acme',
} as unknown as Contact

describe('resolveVariables', () => {
  it('resolves static, field e custom_field na ordem das chaves', () => {
    const vars: Record<string, VariableMapping> = {
      '1': { type: 'static', value: 'Olá' },
      '2': { type: 'field', value: 'name' },
      '3': { type: 'custom_field', value: 'cf1' },
    }
    const custom = new Map([['cf1', 'VIP']])
    expect(resolveVariables(vars, contact, custom)).toEqual(['Olá', 'Ana', 'VIP'])
  })

  it('ordena chaves numéricas: {{1}} antes de {{10}}', () => {
    const vars: Record<string, VariableMapping> = {
      '10': { type: 'static', value: 'dez' },
      '2': { type: 'static', value: 'dois' },
      '1': { type: 'static', value: 'um' },
    }
    expect(resolveVariables(vars, contact)).toEqual(['um', 'dois', 'dez'])
  })

  it('retorna "" para custom value ausente ou field inexistente', () => {
    const vars: Record<string, VariableMapping> = {
      '1': { type: 'custom_field', value: 'inexistente' },
      '2': { type: 'field', value: 'naoExiste' },
    }
    expect(resolveVariables(vars, contact, new Map())).toEqual(['', ''])
  })

  it('mapeia todos os campos embutidos do contato', () => {
    const vars: Record<string, VariableMapping> = {
      '1': { type: 'field', value: 'phone' },
      '2': { type: 'field', value: 'email' },
      '3': { type: 'field', value: 'company' },
    }
    expect(resolveVariables(vars, contact)).toEqual([
      '5521999999999',
      'ana@example.com',
      'Acme',
    ])
  })
})

// Helpers do webhook-broadcast (blueprint+clone)
describe('collectPayloadKeys', () => {
  it('coleta chaves payload dedupadas, ignorando outros tipos e value vazio', () => {
    expect(
      collectPayloadKeys({
        '1': { type: 'payload', value: 'link_aula' },
        '2': { type: 'static', value: 'x' },
        '3': { type: 'payload', value: 'link_aula' },
        '4': { type: 'payload', value: '' },
        '5': { type: 'field', value: 'name' },
      }),
    ).toEqual(['link_aula'])
    expect(collectPayloadKeys({})).toEqual([])
  })
})

describe('materializePayloadVariables', () => {
  it('converte payload→static com String() e preserva os demais tipos', () => {
    const input = {
      '1': { type: 'payload', value: 'link_aula' },
      '2': { type: 'static', value: 'fixo' },
      '3': { type: 'field', value: 'name' },
      '4': { type: 'payload', value: 'vagas' },
    } as const
    const out = materializePayloadVariables(
      input as unknown as Record<string, VariableMapping>,
      { link_aula: 'https://aula.com/x', vagas: 12 },
    )
    expect(out['1']).toEqual({ type: 'static', value: 'https://aula.com/x' })
    expect(out['2']).toEqual({ type: 'static', value: 'fixo' })
    expect(out['3']).toEqual({ type: 'field', value: 'name' })
    expect(out['4']).toEqual({ type: 'static', value: '12' })
  })

  it('não muta o input e usa "" pra chave ausente', () => {
    const input: Record<string, VariableMapping> = {
      '1': { type: 'payload', value: 'faltando' },
    }
    const out = materializePayloadVariables(input, {})
    expect(out['1']).toEqual({ type: 'static', value: '' })
    expect(input['1']).toEqual({ type: 'payload', value: 'faltando' })
  })
})

describe('resolveVariables — defensivo payload', () => {
  it('payload não materializada resolve como "" (nunca vaza placeholder)', () => {
    const params = resolveVariables(
      { '1': { type: 'payload', value: 'link_aula' } },
      { id: 'c1', name: 'X' } as never,
    )
    expect(params).toEqual([''])
  })
})

describe('extrairPrimeiroNome', () => {
  it('nome normal → primeira palavra', () => {
    expect(extrairPrimeiroNome('Pamella Martins da Silva')).toBe('Pamella')
  })

  // Casos REAIS do lote morno-alto: 6 em minúsculo e 1 em maiúsculo em 100.
  it('normaliza caixa quando a palavra está toda num caso só', () => {
    expect(extrairPrimeiroNome('eduarda gabriele freitas pereira')).toBe('Eduarda')
    expect(extrairPrimeiroNome('ANA KARINA RAMOS ROLIM')).toBe('Ana')
    expect(extrairPrimeiroNome('júlia vitória rodrigues')).toBe('Júlia')
  })

  it('preserva caixa interna legítima', () => {
    expect(extrairPrimeiroNome('McCarthy Souza')).toBe('McCarthy')
    expect(extrairPrimeiroNome("D'Ávila Costa")).toBe("D'Ávila")
  })

  // Telefone no campo nome existe na base — saudação sem nome é melhor que com número.
  it('lixo no campo nome → vazio', () => {
    expect(extrairPrimeiroNome('21989513986')).toBe('')
    expect(extrairPrimeiroNome('.')).toBe('')
    expect(extrairPrimeiroNome('A B')).toBe('')
    expect(extrairPrimeiroNome('')).toBe('')
    expect(extrairPrimeiroNome(null)).toBe('')
    expect(extrairPrimeiroNome(undefined)).toBe('')
  })

  it('partícula solta no começo não vira saudação', () => {
    expect(extrairPrimeiroNome('de Souza Lima')).toBe('Souza')
  })

  it('espaço extra e sobra no fim não atrapalham', () => {
    expect(extrairPrimeiroNome('  Gabriele   Corleth  ')).toBe('Gabriele')
  })
})

describe('valorDoCampo', () => {
  const c = { name: 'ana karina souza', phone: '5521999', email: 'a@b.com' } as never
  it('first_name usa a extração', () => {
    expect(valorDoCampo(c, 'first_name')).toBe('Ana')
  })
  it('demais campos seguem crus', () => {
    expect(valorDoCampo(c, 'name')).toBe('ana karina souza')
    expect(valorDoCampo(c, 'phone')).toBe('5521999')
  })
  it('campo desconhecido → undefined', () => {
    expect(valorDoCampo(c, 'inexistente')).toBeUndefined()
  })
})
