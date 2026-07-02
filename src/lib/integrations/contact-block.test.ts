import { describe, expect, it } from 'vitest'
import { buildContactBlock } from './contact-block'
import type { Contact } from '@/types'

// Contato mínimo válido p/ o tipo; os testes variam os campos que o helper lê.
const base: Contact = {
  id: 'c1',
  user_id: 'u1',
  account_id: 'a1',
  phone: '+55 21 98786-8395',
  name: 'Olivia',
  email: 'olivia@example.com',
  company: 'MB',
  created_at: '2026-07-02T00:00:00Z',
  updated_at: '2026-07-02T00:00:00Z',
}

describe('buildContactBlock', () => {
  it('monta as 5 linhas na ordem Nome/Telefone/Email/Empresa/Conversa', () => {
    expect(buildContactBlock(base, 'https://x.tld/inbox?c=1')).toBe(
      'Nome: Olivia\n' +
        'Telefone: +55 21 98786-8395\n' +
        'Email: olivia@example.com\n' +
        'Empresa: MB\n' +
        'Conversa: https://x.tld/inbox?c=1',
    )
  })

  it('contato null → string vazia', () => {
    expect(buildContactBlock(null, 'https://x.tld/inbox?c=1')).toBe('')
  })

  it('sem URL → sem a linha Conversa', () => {
    const out = buildContactBlock(base, null)
    expect(out).not.toContain('Conversa:')
    expect(out).toContain('Nome: Olivia')
  })

  it('sem email/empresa → omite essas linhas', () => {
    const out = buildContactBlock(
      { ...base, email: undefined, company: undefined },
      null,
    )
    expect(out).toBe('Nome: Olivia\nTelefone: +55 21 98786-8395')
  })

  it('name/phone vazios → usa fallback —', () => {
    const out = buildContactBlock({ ...base, name: '', phone: '' }, null)
    expect(out).toContain('Nome: —')
    expect(out).toContain('Telefone: —')
  })
})
