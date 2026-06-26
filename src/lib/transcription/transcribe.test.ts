import { describe, expect, it, vi, afterEach } from 'vitest'
import { transcribeAudioBytes } from './transcribe'

// Resposta OK do endpoint STT do OpenRouter.
const ok = (text: string, cost = 0.0005) =>
  new Response(JSON.stringify({ text, usage: { cost } }), { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe('transcribeAudioBytes', () => {
  it('usa o primário quando ele responde com texto + manda body correto', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ok('olá mundo'))
    vi.stubGlobal('fetch', fetchMock)

    const r = await transcribeAudioBytes({ apiKey: 'k', base64: 'AAAA', format: 'ogg', primaryModel: 'p', fallbackModel: 'f' })
    expect(r.rawText).toBe('olá mundo')
    expect(r.modelUsed).toBe('p')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
    expect(body.model).toBe('p')
    expect(body.input_audio).toEqual({ data: 'AAAA', format: 'ogg' })
    expect(body.language).toBe('pt')
    expect(body.provider).toEqual({ data_collection: 'deny' })
  })

  it('cai no fallback quando o primário falha (HTTP)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('err', { status: 500 }))
      .mockResolvedValueOnce(ok('do fallback'))
    vi.stubGlobal('fetch', fetchMock)

    const r = await transcribeAudioBytes({ apiKey: 'k', base64: 'A', format: 'mp3', primaryModel: 'p', fallbackModel: 'f' })
    expect(r.rawText).toBe('do fallback')
    expect(r.modelUsed).toBe('f')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('cai no fallback quando o primário retorna texto vazio', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(ok('   ')).mockResolvedValueOnce(ok('texto'))
    vi.stubGlobal('fetch', fetchMock)

    const r = await transcribeAudioBytes({ apiKey: 'k', base64: 'A', format: 'ogg' })
    expect(r.rawText).toBe('texto')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('lança quando ambos falham', async () => {
    const fetchMock = vi.fn(async () => new Response('err', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(transcribeAudioBytes({ apiKey: 'k', base64: 'A', format: 'ogg' })).rejects.toThrow()
  })
})
