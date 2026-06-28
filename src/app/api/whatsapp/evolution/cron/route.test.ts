// ============================================================
// Testa o cron de inbound Evolution por invocação direta. Mocka o
// admin client + evolution-api + findOrCreate*. Cobre auth (503/401),
// filtro de fromMe e a idempotência (rodar 2x → 0 duplicata).
// ============================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Store compartilhado entre o mock e as asserções.
const store = vi.hoisted(() => ({
  conns: [] as Record<string, unknown>[],
  msgs: new Set<string>(), // chave conversation_id|message_id (dedup)
  inserted: 0,
  cursorUpdates: 0,
}))

vi.mock('@/lib/broadcast/admin-client', () => {
  function from(table: string) {
    const f: { table: string; filters: Record<string, unknown>; ins: Record<string, unknown> | null; upd: boolean } = {
      table, filters: {}, ins: null, upd: false,
    }
    const b: Record<string, unknown> = {
      select: () => b,
      update: () => ((f.upd = true), b),
      insert: (row: Record<string, unknown>) => ((f.ins = row), b),
      eq: (k: string, v: unknown) => ((f.filters[k] = v), b),
      maybeSingle: () => Promise.resolve(resolve()),
      then: (res: (v: unknown) => unknown) => Promise.resolve(resolve()).then(res),
    }
    function resolve() {
      if (f.table === 'whatsapp_config') {
        if (f.upd) { store.cursorUpdates++; return { error: null } }
        return { data: store.conns, error: null }
      }
      if (f.table === 'messages') {
        if (f.ins) {
          const key = `${f.ins.conversation_id}|${f.ins.message_id}`
          if (store.msgs.has(key)) return { error: { code: '23505' } }
          store.msgs.add(key); store.inserted++; return { error: null }
        }
        const key = `${f.filters.conversation_id}|${f.filters.message_id}`
        return { data: store.msgs.has(key) ? { id: 'x' } : null, error: null }
      }
      return { error: null } // conversations.update
    }
    return b
  }
  return {
    supabaseAdmin: () => ({
      from,
      storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'http://u' } }) }) },
    }),
  }
})

vi.mock('@/lib/providers/evolution-api', () => ({
  evoFetchMessages: async () => [
    { key: { id: 'M1', fromMe: false, remoteJid: '5521999990000@s.whatsapp.net' }, pushName: 'Aluna', messageType: 'conversation', message: { conversation: 'Oi' }, messageTimestamp: 1782670000 },
    { key: { id: 'M2', fromMe: true, remoteJid: '5521999990000@s.whatsapp.net' }, messageType: 'conversation', message: { conversation: 'eco meu' }, messageTimestamp: 1782670001 },
  ],
  evoBase64FromMedia: async () => null,
}))

vi.mock('@/lib/whatsapp/inbound', () => ({
  findOrCreateContact: async () => ({ contact: { id: 'c1' }, wasCreated: false }),
  findOrCreateConversation: async () => ({ id: 'conv1', unread_count: 0 }),
}))

import { GET } from './route'

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/whatsapp/evolution/cron', { headers })
}

beforeEach(() => {
  store.conns = [{ id: 'k1', account_id: 'a1', user_id: 'u1', instance_name: 'inst1', evolution_base_url: null, last_evo_timestamp: null }]
  store.msgs = new Set()
  store.inserted = 0
  store.cursorUpdates = 0
  process.env.EVOLUTION_API_URL = 'http://evo.test:8080'
  process.env.EVOLUTION_API_KEY = 'k'
})
afterEach(() => { delete process.env.AUTOMATION_CRON_SECRET })

describe('GET /api/whatsapp/evolution/cron', () => {
  it('503 sem secret', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    expect((await GET(req())).status).toBe(503)
  })

  it('401 com secret errado', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'certo'
    expect((await GET(req({ 'x-cron-secret': 'errado' }))).status).toBe(401)
  })

  it('importa só inbound (fromMe filtrado) e é idempotente (2x → 0 dup)', async () => {
    process.env.AUTOMATION_CRON_SECRET = 'certo'
    const r1 = await (await GET(req({ 'x-cron-secret': 'certo' }))).json()
    expect(r1.imported).toBe(1) // M1 (inbound); M2 (fromMe) ignorado
    expect(store.inserted).toBe(1)

    // 2ª rodada: cursor avançou + dedup → nenhuma nova mensagem.
    store.conns[0].last_evo_timestamp = 1782670000
    const r2 = await (await GET(req({ 'x-cron-secret': 'certo' }))).json()
    expect(r2.imported).toBe(0)
    expect(store.inserted).toBe(1) // continua 1 — sem duplicar
  })
})
