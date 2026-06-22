import { describe, expect, it, vi, afterEach } from 'vitest'
import { fetchStudentInfo } from './student-info'

afterEach(() => vi.unstubAllGlobals())

describe('fetchStudentInfo', () => {
  it('manda email+telefone no body e devolve success', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({ status: 'success', matched_by: 'email', aluno: { id: 1, nome: 'X' } }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchStudentInfo({ apiKey: 'k', email: 'a@b.com', phone: '31999998888' })
    expect(out.status).toBe('success')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.email).toBe('a@b.com')
    expect(body.telefone).toBe('31999998888')
    // a key vai no header, não no body
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>
    expect(headers['X-API-KEY']).toBe('k')
  })

  it('omite campos vazios (só telefone)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ status: 'nao_encontrado' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await fetchStudentInfo({ apiKey: 'k', email: '', phone: '319999' })
    expect(out.status).toBe('nao_encontrado')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.email).toBeUndefined()
    expect(body.telefone).toBe('319999')
  })

  it('multiplos → devolve candidatos', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ status: 'multiplos', candidatos: [{ id: 1, nome: 'A' }] }), { status: 200 }),
    ))
    const out = await fetchStudentInfo({ apiKey: 'k', phone: '319' })
    expect(out.status).toBe('multiplos')
    expect(out.candidatos).toHaveLength(1)
  })

  it('HTTP de erro → lança sem vazar a key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    await expect(
      fetchStudentInfo({ apiKey: 'secreta', email: 'a@b.com' }),
    ).rejects.toThrow(/Millaborges error 401/)
    // a mensagem não contém a key
    await expect(
      fetchStudentInfo({ apiKey: 'secreta', email: 'a@b.com' }),
    ).rejects.not.toThrow(/secreta/)
  })
})
