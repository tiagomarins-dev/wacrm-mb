import { describe, expect, it } from 'vitest'
import { conversationTitle } from './conversation-title'

describe('conversationTitle', () => {
  it('1:1: usa nome do contato', () => {
    expect(conversationTitle({ contact: { name: 'Ana', phone: '5521999' } } as never)).toBe('Ana')
  })

  it('1:1: cai no telefone sem nome', () => {
    expect(conversationTitle({ contact: { phone: '5521999' } } as never)).toBe('5521999')
  })

  it('1:1: fallback Desconhecido sem contato', () => {
    expect(conversationTitle({ is_group: false } as never)).toBe('Desconhecido')
  })

  it('grupo: usa o groupName quando informado', () => {
    expect(
      conversationTitle({ is_group: true, chat_id: '120363012345678901@g.us' } as never, 'Turma 2026'),
    ).toBe('Turma 2026')
  })

  it('grupo: fallback "Grupo <sufixo do chat_id>"', () => {
    expect(
      conversationTitle({ is_group: true, chat_id: '120363012345678901@g.us' } as never),
    ).toBe('Grupo 8901')
  })

  it('grupo: fallback "Grupo" sem chat_id', () => {
    expect(conversationTitle({ is_group: true } as never)).toBe('Grupo')
  })

  it('grupo: groupName em branco cai no fallback', () => {
    expect(conversationTitle({ is_group: true, chat_id: '999@g.us' } as never, '   ')).toBe('Grupo 999')
  })
})
