import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchCourseStudents, MbApiError, resolveMbApiKey } from './platform-api'
import { encrypt } from '@/lib/whatsapp/encryption'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('fetchCourseStudents', () => {
  it('POST com id_curso no body e a chave só no header', async () => {
    const fetchMock = stubFetch(200, {
      status: 'success',
      curso: { id_curso: 90, nome_curso: 'MB Turbo 2026', vigente: 'S' },
      ativos: [{ id_aluno: 1, nome: 'Ana', email: 'a@b.com', telefone: '5521987654321', usuario_vigente: 'S' }],
      nao_ativos: [],
    })
    const out = await fetchCourseStudents('chave-secreta', 90)
    expect(out).toMatchObject({ found: true, curso: { nome_curso: 'MB Turbo 2026' } })
    if (out.found) expect(out.ativos).toHaveLength(1)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://app.millaborges.com/api/curso.alunos.php')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ id_curso: 90 })
    expect((init.headers as Record<string, string>)['X-API-KEY']).toBe('chave-secreta')
  })

  it('curso inexistente → found:false', async () => {
    stubFetch(200, { status: 'curso_nao_encontrado' })
    expect(await fetchCourseStudents('k', 999)).toEqual({ found: false })
  })

  it('401 e 429 viram códigos próprios, sem a chave na mensagem', async () => {
    stubFetch(401, { status: 'nao_autorizado' })
    const e1 = await fetchCourseStudents('chave-secreta', 90).catch((e) => e)
    expect(e1).toBeInstanceOf(MbApiError)
    expect(e1.code).toBe('unauthorized')
    expect(e1.message).not.toContain('chave-secreta')

    stubFetch(429, { status: 'rate_limited' })
    expect((await fetchCourseStudents('k', 90).catch((e) => e)).code).toBe('rate_limited')
  })

  it('HTTP 500, corpo inválido e turma truncada → erro', async () => {
    stubFetch(500, { status: 'erro' })
    expect((await fetchCourseStudents('k', 90).catch((e) => e)).code).toBe('http_500')

    stubFetch(200, '')
    expect((await fetchCourseStudents('k', 90).catch((e) => e)).code).toBe('invalid_response')

    stubFetch(200, { status: 'success', curso: { id_curso: 90, nome_curso: 'X', vigente: 'S' }, ativos: [], truncado: true })
    expect((await fetchCourseStudents('k', 90).catch((e) => e)).code).toBe('truncated')
  })

  it('falha de rede → network', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('fetch failed')
    }))
    expect((await fetchCourseStudents('k', 90).catch((e) => e)).code).toBe('network')
  })
})

describe('resolveMbApiKey', () => {
  function db(enc: string | null) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: async () => ({ data: enc === null ? null : { millaborges_api_key: enc }, error: null }),
    }
    return { from: () => b } as never
  }

  it('decripta a chave salva na conta', async () => {
    expect(await resolveMbApiKey(db(encrypt('da-conta')), 'acc')).toBe('da-conta')
  })

  it('sem chave na conta (ou ilegível) → env API_ALUNO_KEY', async () => {
    vi.stubEnv('API_ALUNO_KEY', 'da-env')
    expect(await resolveMbApiKey(db(null), 'acc')).toBe('da-env')
    expect(await resolveMbApiKey(db('lixo'), 'acc')).toBe('da-env')
  })

  it('nada configurado → null', async () => {
    vi.stubEnv('API_ALUNO_KEY', '')
    expect(await resolveMbApiKey(db(null), 'acc')).toBeNull()
  })
})
