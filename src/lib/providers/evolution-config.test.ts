// ============================================================
// Testa o handler de conexão Evolution (create/edit) por invocação
// direta. Mocka o supabase com builder encadeável (mesmo estilo do
// cron/route.test.ts) e a Evolution via MSW. Cobre as colisões de nome
// (pré-check ativa/arquivada, 403 do servidor, 23505 no INSERT e no
// UPDATE) e os caminhos felizes de create/edit.
// ============================================================
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import type { SupabaseClient } from '@supabase/supabase-js'
import { server } from '@/test/msw/server'
import { handleEvolutionConfig } from './evolution-config'

const BASE = 'http://evo.test:8080'

// Estado que os mocks consultam; resetado por teste.
const store = {
  clash: null as Record<string, unknown> | null,
  existing: null as Record<string, unknown> | null,
  count: 1,
  inserted: { id: 'new-conn' } as Record<string, unknown> | null,
  insertError: null as { code?: string } | null,
  updateError: null as { code?: string } | null,
}

// Builder encadeável mínimo: resolve pela forma da query (pré-check de
// colisão / count / select de edição / update / insert).
function makeSupabase(): SupabaseClient {
  function from() {
    const f: { cols: string; count: boolean; upd: boolean; filters: Record<string, unknown> } = {
      cols: '', count: false, upd: false, filters: {},
    }
    const b: Record<string, unknown> = {
      select: (cols?: string, opts?: { count?: string }) => {
        f.cols = cols ?? ''
        if (opts?.count) f.count = true
        return b
      },
      update: () => ((f.upd = true), b),
      insert: () => ({
        select: () => ({
          single: async () => ({ data: store.insertError ? null : store.inserted, error: store.insertError }),
        }),
      }),
      eq: (k: string, v: unknown) => ((f.filters[k] = v), b),
      maybeSingle: async () => {
        if (f.cols.includes('archived_at')) return { data: store.clash }
        return { data: store.existing }
      },
      then: (res: (v: unknown) => unknown) => {
        if (f.upd) return Promise.resolve({ error: store.updateError }).then(res)
        if (f.count) return Promise.resolve({ count: store.count, error: null }).then(res)
        return Promise.resolve({ data: null, error: null }).then(res)
      },
    }
    return b
  }
  return { from } as unknown as SupabaseClient
}

function callCreate(instanceName = 'inst1') {
  return handleEvolutionConfig({
    supabase: makeSupabase(),
    accountId: 'a1',
    userId: 'u1',
    body: { instance_name: instanceName, label: 'Suporte' },
  })
}

function callEdit(instanceName = 'inst1') {
  return handleEvolutionConfig({
    supabase: makeSupabase(),
    accountId: 'a1',
    userId: 'u1',
    body: { connection_id: 'c1', instance_name: instanceName },
  })
}

// Evolution aceitando o create por padrão (caminho feliz).
function evolutionCreateOk() {
  server.use(
    http.post(`${BASE}/instance/create`, () =>
      HttpResponse.json({ qrcode: { base64: 'QR-B64' } }),
    ),
  )
}

beforeEach(() => {
  store.clash = null
  store.existing = null
  store.count = 1
  store.inserted = { id: 'new-conn' }
  store.insertError = null
  store.updateError = null
  process.env.EVOLUTION_API_URL = BASE
  process.env.EVOLUTION_API_KEY = 'k'
})

afterEach(() => {
  delete process.env.EVOLUTION_API_URL
  delete process.env.EVOLUTION_API_KEY
})

describe('handleEvolutionConfig — colisões de nome', () => {
  it('409 quando o nome já é de uma conexão ativa da conta (pré-check)', async () => {
    store.clash = { id: 'c9', label: 'Suporte (4997)', archived_at: null }
    const res = await callCreate('suporte-4997')
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('já é usado pela conexão "Suporte (4997)"')
    expect(body.error).toContain('Reconectar / novo QR')
  })

  it('409 quando o nome pertence a uma conexão arquivada', async () => {
    store.clash = { id: 'c9', label: 'Velha', archived_at: '2026-07-09T00:00:00Z' }
    const res = await callCreate()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('conexão arquivada')
  })

  it('409 quando a Evolution responde 403 already in use (create)', async () => {
    server.use(
      http.post(`${BASE}/instance/create`, () =>
        HttpResponse.json(
          { status: 403, error: 'Forbidden', response: { message: ['This name "inst1" is already in use.'] } },
          { status: 403 },
        ),
      ),
    )
    const res = await callCreate()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('já existe no servidor Evolution')
  })

  it('409 na corrida do INSERT (23505 do índice único)', async () => {
    evolutionCreateOk()
    store.insertError = { code: '23505' }
    const res = await callCreate()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('já é usado por outra conexão')
  })

  it('409 no UPDATE que renomeia p/ nome já usado (23505)', async () => {
    evolutionCreateOk()
    store.existing = { id: 'c1' }
    store.updateError = { code: '23505' }
    const res = await callEdit('nome-de-outra')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('já é usado por outra conexão')
  })

  it('outros erros da Evolution seguem como 502', async () => {
    server.use(
      http.post(`${BASE}/instance/create`, () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    )
    const res = await callCreate()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('Falha ao criar instância na Evolution')
  })
})

describe('handleEvolutionConfig — caminhos felizes', () => {
  it('create: contrato { success, provider, connection_id, qr_base64 } preservado', async () => {
    evolutionCreateOk()
    const res = await callCreate()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      provider: 'evolution',
      connection_id: 'new-conn',
      qr_base64: 'QR-B64',
    })
  })

  it('edição: atualiza a row existente e devolve o QR', async () => {
    evolutionCreateOk()
    store.existing = { id: 'c1' }
    const res = await callEdit()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      success: true,
      provider: 'evolution',
      connection_id: 'c1',
      qr_base64: 'QR-B64',
    })
  })
})
