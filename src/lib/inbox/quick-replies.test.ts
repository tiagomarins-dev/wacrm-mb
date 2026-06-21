import { describe, expect, it } from 'vitest'
import { renderQuickReply, filterQuickReplies } from './quick-replies'
import type { Contact, QuickReply } from '@/types'

const contact = {
  id: 'c1',
  name: 'Tiago Marins',
  phone: '5521999999999',
  email: 'tiago@example.com',
  company: 'Acme',
} as unknown as Contact

describe('renderQuickReply', () => {
  it('substitui os campos do contato', () => {
    expect(renderQuickReply('Oi {{name}}, tudo bem?', contact)).toBe(
      'Oi Tiago Marins, tudo bem?',
    )
  })

  it('substitui múltiplas ocorrências da mesma variável', () => {
    expect(renderQuickReply('{{name}} … {{name}}', contact)).toBe(
      'Tiago Marins … Tiago Marins',
    )
  })

  it('campo ausente → string vazia (nunca "undefined")', () => {
    const noCompany = { ...contact, company: undefined } as unknown as Contact
    expect(renderQuickReply('Empresa: {{company}}.', noCompany)).toBe('Empresa: .')
  })

  it('placeholder desconhecido → vazio', () => {
    expect(renderQuickReply('{{foo}}{{name}}', contact)).toBe('Tiago Marins')
  })

  it('espaços não casam (literal); key uppercase fora do set → vazio', () => {
    // {{ name }} tem espaços → não casa \w+ → fica literal.
    // {{NAME}} casa mas 'NAME' não está no set (só lowercase) → ''.
    expect(renderQuickReply('{{ name }}/{{NAME}}', contact)).toBe('{{ name }}/')
  })

  it('texto sem variáveis fica inalterado', () => {
    expect(renderQuickReply('Olá!', contact)).toBe('Olá!')
  })

  it('contato nulo → variáveis viram vazio', () => {
    expect(renderQuickReply('Oi {{name}}', null)).toBe('Oi ')
  })
})

const replies: QuickReply[] = [
  { shortcut: 'ola', message_text: 'Oi {{name}}, tudo bem?' } as QuickReply,
  { shortcut: 'horario', message_text: 'Atendemos das 9h às 18h' } as QuickReply,
]

describe('filterQuickReplies', () => {
  it('query vazia → tudo', () => {
    expect(filterQuickReplies(replies, '')).toHaveLength(2)
  })

  it('casa por shortcut (case-insensitive)', () => {
    expect(filterQuickReplies(replies, 'OLA')).toEqual([replies[0]])
  })

  it('casa pelo texto da resposta', () => {
    expect(filterQuickReplies(replies, '18h')).toEqual([replies[1]])
  })

  it('sem match → vazio', () => {
    expect(filterQuickReplies(replies, 'zzz')).toHaveLength(0)
  })
})
