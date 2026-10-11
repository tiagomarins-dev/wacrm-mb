import { describe, expect, it } from 'vitest'
import { isSaleUrl, loadCourseSaleLinks } from './sale-link'

const COURSES = ['https://bit.ly/maratonamb-zap-atendimento']

describe('isSaleUrl', () => {
  it('checkout da Hotmart é venda, com ou sem oferta', () => {
    expect(isSaleUrl('https://pay.hotmart.com/O106563458B?off=hh3vdrpf', [])).toBe(true)
    expect(isSaleUrl('https://PAY.hotmart.com/X', [])).toBe(true)
  })

  it('outros endereços da Hotmart não são venda', () => {
    expect(isSaleUrl('https://help.hotmart.com/pt-br', [])).toBe(false)
    expect(isSaleUrl('https://consumer.hotmart.com/', [])).toBe(false)
  })

  it('link de matrícula de curso é venda, ignorando barra final', () => {
    expect(isSaleUrl('https://bit.ly/maratonamb-zap-atendimento', COURSES)).toBe(true)
    expect(isSaleUrl('https://bit.ly/maratonamb-zap-atendimento/', COURSES)).toBe(true)
  })

  it('link qualquer não é venda', () => {
    expect(isSaleUrl('https://bit.ly/outro', COURSES)).toBe(false)
    expect(isSaleUrl('https://app.millaborges.com/login', COURSES)).toBe(false)
  })

  it('url inválida não é venda', () => {
    expect(isSaleUrl('nao-e-url', COURSES)).toBe(false)
  })
})

// Fake db encadeável que resolve no fim da cadeia (.not).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(result: { data: any; error: any }) {
  const b: Record<string, unknown> = {
    select: () => b,
    eq: () => b,
    not: () => Promise.resolve(result),
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from: () => b } as any
}

describe('loadCourseSaleLinks', () => {
  it('devolve os links preenchidos', async () => {
    const db = makeDb({ data: [{ link_venda: 'https://a.com' }, { link_venda: null }], error: null })
    expect(await loadCourseSaleLinks(db, 'acc')).toEqual(['https://a.com'])
  })

  it('erro na leitura devolve lista vazia', async () => {
    const db = makeDb({ data: null, error: { message: 'boom' } })
    expect(await loadCourseSaleLinks(db, 'acc')).toEqual([])
  })
})
