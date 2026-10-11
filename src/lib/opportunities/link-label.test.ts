import { describe, expect, it } from 'vitest'
import { linkLabel } from './link-label'

describe('linkLabel', () => {
  it('checkout da Hotmart: tira protocolo e oferta', () => {
    expect(linkLabel('https://pay.hotmart.com/O106563458B?off=hh3vdrpf')).toBe('pay.hotmart.com/O106563458B')
  })

  it('encurtador: domínio + caminho', () => {
    expect(linkLabel('https://bit.ly/maratonamb-zap-atendimento')).toBe('bit.ly/maratonamb-zap-atendimento')
  })

  it('tira www. e barra final', () => {
    expect(linkLabel('https://www.exemplo.com/curso/')).toBe('exemplo.com/curso')
    expect(linkLabel('https://exemplo.com/')).toBe('exemplo.com')
  })

  it('url inválida volta como veio', () => {
    expect(linkLabel('nao-e-url')).toBe('nao-e-url')
  })
})
