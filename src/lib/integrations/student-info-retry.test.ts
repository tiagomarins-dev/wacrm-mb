import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchStudentInfoWithRetry } from './student-info'

afterEach(() => vi.unstubAllGlobals())

// Wrapper do sales-cron (F2): normaliza o fone + retry 1× na variante do 9º dígito.
describe('fetchStudentInfoWithRetry', () => {
  it('success na 1ª → 1 chamada só, fone normalizado', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ status: 'success' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchStudentInfoWithRetry({ apiKey: 'k', phone: '+55 (21) 98765-4321' })
    expect(out.status).toBe('success')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.telefone).toBe('5521987654321') // normalizado (só dígitos)
  })

  it('nao_encontrado + fone BR → 2ª chamada com a variante do 9º dígito', async () => {
    const fetchMock = vi
      .fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'nao_encontrado' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'success' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchStudentInfoWithRetry({ apiKey: 'k', phone: '5521987654321' })
    expect(out.status).toBe('success')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(body2.telefone).toBe('552187654321') // sem o 9
  })

  it('nao_encontrado + fone não-BR → sem retry (1 chamada)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'nao_encontrado' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchStudentInfoWithRetry({ apiKey: 'k', phone: '37063949836' })
    expect(out.status).toBe('nao_encontrado')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('2ª também falha (nao_encontrado) → devolve a 1ª resposta', async () => {
    const fetchMock = vi
      .fn(async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'nao_encontrado', matched_by: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'nao_encontrado' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchStudentInfoWithRetry({ apiKey: 'k', phone: '5521987654321' })
    expect(out.status).toBe('nao_encontrado')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sem telefone (só email) → sem retry', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: 'nao_encontrado' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await fetchStudentInfoWithRetry({ apiKey: 'k', email: 'a@b.com' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
