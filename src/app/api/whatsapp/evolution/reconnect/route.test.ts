// ============================================================
// Testa a reconexão de conexão Evolution por invocação direta do
// handler (sem HTTP), espelhando connect/route.test.ts. Cobre auth
// (401/403/400/404/503), open→connected, recriação da instância no 404
// (com corrida create-403 → fallback evoConnect), sync de disconnected
// e os 502 estruturados.
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'

// Estado compartilhado p/ o mock do supabase (hoisted p/ o vi.mock ler).
const h = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  account: 'a1' as string | null,
  config: null as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  isFilters: [] as [string, unknown][],
  state: 'close',
  qr: 'QR-NOVO',
  // Erros/retornos injetáveis do client Evolution.
  stateThrows: null as unknown,
  connectThrows: null as unknown,
  createThrows: null as unknown,
  createQr: 'QR-CREATE',
  createCalls: 0,
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
      is: (k: string, v: unknown) => (h.isFilters.push([k, v]), b),
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
// route reconhecer 404/403 tipados.
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
    evoCreateInstance: async () => {
      h.createCalls++
      if (h.createThrows) throw h.createThrows
      return { qrBase64: h.createQr }
    },
  }
})

import { POST } from './route'
import { EvolutionApiError } from '@/lib/providers/evolution-api'

function req(body?: unknown) {
  return new Request('http://localhost/api/whatsapp/evolution/reconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const NOT_FOUND = () => new EvolutionApiError(404, 'The "inst1" instance does not exist')

afterEach(() => {
  h.user = { id: 'u1' }
  h.account = 'a1'
  h.config = null
  h.updates = []
  h.isFilters = []
  h.state = 'close'
  h.stateThrows = null
  h.connectThrows = null
  h.createThrows = null
  h.createQr = 'QR-CREATE'
  h.createCalls = 0
  process.env.EVOLUTION_API_URL = 'http://evo.test:8080'
  process.env.EVOLUTION_API_KEY = 'k'
})

describe('POST /api/whatsapp/evolution/reconnect', () => {
  it('401 sem user', async () => {
    h.user = null
    expect((await POST(req({ connection_id: 'c1' }))).status).toBe(401)
  })

  it('403 sem conta', async () => {
    h.account = null
    expect((await POST(req({ connection_id: 'c1' }))).status).toBe(403)
  })

  it('400 sem connection_id', async () => {
    expect((await POST(req({}))).status).toBe(400)
    expect((await POST(req())).status).toBe(400)
  })

  it('404 quando a conexão não é da conta/evolution (ou está arquivada)', async () => {
    h.config = null
    const res = await POST(req({ connection_id: 'c1' }))
    expect(res.status).toBe(404)
    // O select exige archived_at IS NULL — arquivada nunca chega ao handler.
    expect(h.isFilters).toContainEqual(['archived_at', null])
  })

  it('503 sem env da Evolution', async () => {
    delete process.env.EVOLUTION_API_URL
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    expect((await POST(req({ connection_id: 'c1' }))).status).toBe(503)
  })

  it('state=open → marca conectada e retorna connected', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.state = 'open'
    const res = await POST(req({ connection_id: 'c1' }))
    expect((await res.json()).status).toBe('connected')
    expect(h.updates.some((u) => u.status === 'connected')).toBe(true)
  })

  it('instância inexistente → recria com o mesmo nome e devolve QR (recreated:true)', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'connected' }
    h.stateThrows = NOT_FOUND()
    const res = await POST(req({ connection_id: 'c1' }))
    expect(await res.json()).toEqual({ status: 'pending', qr_base64: 'QR-CREATE', recreated: true })
    expect(h.createCalls).toBe(1)
    expect(h.updates.some((u) => u.status === 'disconnected')).toBe(true)
  })

  it('corrida: create 403 already-in-use → cai no evoConnect (recreated:false)', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.stateThrows = NOT_FOUND()
    h.createThrows = new EvolutionApiError(403, 'This name "inst1" is already in use.')
    const res = await POST(req({ connection_id: 'c1' }))
    expect(await res.json()).toEqual({ status: 'pending', qr_base64: 'QR-NOVO', recreated: false })
  })

  it("state='close' com row connected → sincroniza disconnected e devolve QR", async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'connected' }
    h.state = 'close'
    const res = await POST(req({ connection_id: 'c1' }))
    expect(await res.json()).toEqual({ status: 'pending', qr_base64: 'QR-NOVO', recreated: false })
    expect(h.updates.some((u) => u.status === 'disconnected')).toBe(true)
  })

  it('erro genérico no state → 502', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.stateThrows = new EvolutionApiError(500, 'boom')
    const res = await POST(req({ connection_id: 'c1' }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Falha ao reconectar na Evolution')
  })

  it('erro no create da recriação (não é name-in-use) → 502', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.stateThrows = NOT_FOUND()
    h.createThrows = new EvolutionApiError(500, 'boom')
    const res = await POST(req({ connection_id: 'c1' }))
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Falha ao recriar a instância na Evolution')
  })

  it('erro no evoConnect → 502', async () => {
    h.config = { id: 'c1', instance_name: 'inst1', evolution_base_url: null, status: 'disconnected' }
    h.state = 'connecting'
    h.connectThrows = new EvolutionApiError(500, 'boom')
    const res = await POST(req({ connection_id: 'c1' }))
    expect(res.status).toBe(502)
  })
})
