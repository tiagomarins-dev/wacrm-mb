import { describe, expect, it } from 'vitest'
import { resolveVariables, type VariableMapping } from './variables'
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
