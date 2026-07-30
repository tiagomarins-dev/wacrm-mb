// ============================================================
// Testa o poll de QR/estado da conexão Evolution por invocação direta
// do handler (sem HTTP). Mocka o supabase server + o cliente evolution.
// Cobre: 401/403/400/404, state=open (marca conectada) e pending (QR).
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'

// Estado compartilhado p/ o mock do supabase (hoisted p/ o vi.mock ler).
const h = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  account: 'a1' as string | null,
  config: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  state: 'close',
  qr: 'QR-NOVO',
  // Erros injetáveis do client Evolution (null = sem erro).
  stateThrows: null as unknown,
  connectThrows: null as unknown,
}))

vi.mock('@/lib/supabase/server', () => {
  // Builder encadeável mínimo: resolve por tabela no maybeSingle().
  function from(table: string) {
    const b: Record<string, unknown> = {
      _table: table,
      _update: null as unknown,
      select: () => b,
      update: (p: unknown) => ((b._update = p), b),
      eq: () => b,
      is: () => b,
      maybeSingle: () => {
        if (table === 'profiles') return Promise.resolve({ data: h.account ? { account_id: h.account } : null })
        if (table === 'whatsapp_config') return Promise.resolve({ data: h.config })
        return Promise.resolve({ data: null })
      },
      then: (f: (v: unknown) => unknown) => {
        // update().eq().eq() → registra a mudança de status.
        if (b._update) h.updates.push(b._update as Record<string, unknown>)
        return Promise.resolve({ error: null }).then(f)
      },
    }
    return b
  }
  return {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: h.user } }) },
      from,
    }),
  }
})

// Mocka só as funções de rede; helpers/classe de erro seguem reais p/ o
// route reconhecer o 404 tipado.
vi.mock('@/lib/providers/evolution-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/providers/evolution-api')>()
  return {
    ...actual,
    evoConnectionState: async () => {
      if (h.stateThrows) throw h.stateThrows
      return { state: h.state }
    },
    evoConnect: async () => {
      if (h.connectThrows) throw h.connectThrows
      return { qrBase64: h.qr }
    },
  }
})

import { GET } from './route'
import { EvolutionApiError } from '@/lib/providers/evolution-api'

function req(qs = '') {
  return new Request(`http://localhost/api/whatsapp/evolution/connect${qs}`)
}

afterEach(() => {
  h.user = { id: 'u1' }
  h.account = 'a1'
  h.config = null
  h.updates = []
  h.state = 'close'
  h.stateThrows = null
  h.connectThrows = null
  process.env.EVOLUTION_API_URL = 'http://evo.test:8080'
  process.env.EVOLUTION_API_KEY = 'k'
})

describe('GET /api/whatsapp/evolution/connect', () => {
  it('401 sem user', async () => {
    h.user = null
    expect((await GET(req('?connection_id=c1'))).status).toBe(401)
  })

  it('403 sem conta', async () => {
    h.account = null
    expect((await GET(req('?connection_id=c1'))).status).toBe(403)
  })

  it('400 sem connection_id', async () => {
    expect((await GET(req())).status).toBe(400)
  })

  it('404 quando a conexão não é da conta/evolution', async () => {
    h.config = null
    expect((await GET(req('?connection_id=c1'))).status).toBe(404)
  })

  it('state=open → marca conectada e retorna connected', async () => {
    process.env.EVOLUTION_API_URL = 'http://evo.test:8080'
    process.env.EVOLUTION_API_KEY = 'k'
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.state = 'open'
    const res = await GET(req('?connection_id=c1'))
    const body = await res.json()
    expect(body.status).toBe('connected')
    expect(h.updates.some((u) => u.status === 'connected')).toBe(true)
  })

  it('state≠open → pending com qr_base64', async () => {
    process.env.EVOLUTION_API_URL = 'http://evo.test:8080'
    process.env.EVOLUTION_API_KEY = 'k'
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.state = 'connecting'
    const body = await (await GET(req('?connection_id=c1'))).json()
    expect(body).toEqual({ status: 'pending', qr_base64: 'QR-NOVO' })
  })

  it('instância inexistente (404) → not_found e sincroniza disconnected', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'connected' }
    h.stateThrows = new EvolutionApiError(404, 'The "inst1" instance does not exist')
    const res = await GET(req('?connection_id=c1'))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('not_found')
    expect(h.updates.some((u) => u.status === 'disconnected')).toBe(true)
  })

  it("state='close' com row connected → sincroniza disconnected e devolve QR", async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'connected' }
    h.state = 'close'
    const res = await GET(req('?connection_id=c1'))
    expect((await res.json())).toEqual({ status: 'pending', qr_base64: 'QR-NOVO' })
    expect(h.updates.some((u) => u.status === 'disconnected')).toBe(true)
  })

  it('erro genérico no state → 502 estruturado', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.stateThrows = new EvolutionApiError(500, 'boom')
    const res = await GET(req('?connection_id=c1'))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Falha ao consultar o servidor Evolution')
  })

  it('erro no evoConnect → 502 estruturado', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.state = 'connecting'
    h.connectThrows = new EvolutionApiError(500, 'boom')
    const res = await GET(req('?connection_id=c1'))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Falha ao gerar QR na Evolution')
  })
})
