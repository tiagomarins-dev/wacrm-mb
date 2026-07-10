import { describe, expect, it } from 'vitest'
import { findUrls, extractManualToken, buildLinkParts } from './url-detect'

const TOKEN = 'a'.repeat(32) // 32 hex válido p/ os testes

describe('findUrls', () => {
  it('apara o ponto final que não faz parte da URL', () => {
    const r = findUrls('veja https://x.com/p.')
    expect(r).toHaveLength(1)
    expect(r[0].url).toBe('https://x.com/p')
  })

  it('apara o fecha-parêntese final', () => {
    const r = findUrls('(https://x.com)')
    expect(r).toHaveLength(1)
    expect(r[0].url).toBe('https://x.com')
  })

  it('acha múltiplas URLs', () => {
    const r = findUrls('a https://x.com b http://y.io/z c')
    expect(r.map((u) => u.url)).toEqual(['https://x.com', 'http://y.io/z'])
  })

  it('texto sem URL → []', () => {
    expect(findUrls('sem link aqui')).toEqual([])
  })
})

describe('extractManualToken', () => {
  it('extrai os 32 hex de .../r/<token>', () => {
    expect(extractManualToken(`https://site.com/r/${TOKEN}`)).toBe(TOKEN)
  })

  it('URL comum → null', () => {
    expect(extractManualToken('https://x.com/p')).toBeNull()
  })
})

describe('buildLinkParts', () => {
  it('/r/<token> com original no mapa → link p/ o original', () => {
    const parts = buildLinkParts(`veja https://s/r/${TOKEN}`, { [TOKEN]: 'https://real.com/x' })
    expect(parts).toContainEqual({ kind: 'link', href: 'https://real.com/x', label: 'https://real.com/x' })
  })

  it('/r/<token> sem original ainda → raw (texto puro)', () => {
    const parts = buildLinkParts(`veja https://s/r/${TOKEN}`, {})
    expect(parts).toContainEqual({ kind: 'raw', text: `https://s/r/${TOKEN}` })
  })

  it('URL comum → link direto', () => {
    const parts = buildLinkParts('abre https://x.com/p', {})
    expect(parts).toContainEqual({ kind: 'link', href: 'https://x.com/p', label: 'https://x.com/p' })
  })

  it('intercala texto e link', () => {
    const parts = buildLinkParts('a https://x.com b', {})
    expect(parts[0]).toEqual({ kind: 'text', text: 'a ' })
    expect(parts[1]).toEqual({ kind: 'link', href: 'https://x.com', label: 'https://x.com' })
    expect(parts[2]).toEqual({ kind: 'text', text: ' b' })
  })

  it('texto puro → uma parte text', () => {
    expect(buildLinkParts('sem link', {})).toEqual([{ kind: 'text', text: 'sem link' }])
  })
})
