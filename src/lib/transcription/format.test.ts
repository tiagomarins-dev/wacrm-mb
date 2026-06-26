import { describe, expect, it, vi, afterEach } from 'vitest'
import { formatTranscription } from './format'

// Resposta OK do /chat/completions (content = string JSON).
const chat = (content: string, cost = 0.0001) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost } }), { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe('formatTranscription', () => {
  it('devolve texto formatado quando makesSense=true', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      chat(JSON.stringify({ makesSense: true, text: 'Olá, tudo bem?' })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const r = await formatTranscription({ apiKey: 'k', rawText: 'ola tudo bem' })
    expect(r.makesSense).toBe(true)
    expect(r.text).toBe('Olá, tudo bem?')

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.provider).toEqual({ data_collection: 'deny' })
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('makesSense=false quando o modelo julga sem conteúdo', async () => {
    const fetchMock = vi.fn(async () => chat(JSON.stringify({ makesSense: false, text: '' })))
    vi.stubGlobal('fetch', fetchMock)

    const r = await formatTranscription({ apiKey: 'k', rawText: '...ruído...' })
    expect(r.makesSense).toBe(false)
  })

  it('JSON malformado vira sem conteúdo (parsing defensivo)', async () => {
    const fetchMock = vi.fn(async () => chat('isto não é json'))
    vi.stubGlobal('fetch', fetchMock)

    const r = await formatTranscription({ apiKey: 'k', rawText: 'algo' })
    expect(r.makesSense).toBe(false)
    expect(r.text).toBe('')
  })

  it('boundary: rawText vazio NÃO chama o LLM', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const r = await formatTranscription({ apiKey: 'k', rawText: '   ' })
    expect(r).toEqual({ makesSense: false, text: '', costUsd: 0 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
