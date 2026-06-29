// ============================================================
// Testa o cron de inbound Evolution por invocação direta. Mocka o
// admin client + evolution-api + findOrCreate* + os 4 dispatchers
// (flows/automações/IA/transcrição). Cobre auth (503/401), filtro de
// fromMe, idempotência, grupo (058) e o DISPATCH de engines no ramo 1:1
// (paridade com o webhook Meta).
// ============================================================
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Store compartilhado entre os mocks e as asserções.
const store = vi.hoisted(() => ({
  conns: [] as Record<string, unknown>[],
  records: [] as Record<string, unknown>[],
  msgs: new Set<string>(), // chave conversation_id|message_id (dedup)
  inserted: 0,
  lastInsert: null as Record<string, unknown> | null,
  groupConvCalls: [] as unknown[],
  cursorUpdates: 0,
  // Controles dos mocks de dispatch/contato.
  wasCreated: false,
  priorCustomerMsgCount: 1, // >0 → não é primeira msg (default)
  flowConsumed: false,
  flowThrows: false,
  autoThrows: false,
  media: null as { base64: string; mimetype: string } | null,
}))

vi.mock('@/lib/broadcast/admin-client', () => {
  function from(table: string) {
    const f: {
      table: string; filters: Record<string, unknown>
      ins: Record<string, unknown> | null; upd: boolean; count: boolean
    } = { table, filters: {}, ins: null, upd: false, count: false }
    const b: Record<string, unknown> = {
      // count:'exact'/head → query de contagem (isFirstInboundMessage).
      select: (_cols?: unknown, opts?: { count?: string }) => {
        if (opts && opts.count) f.count = true
        return b
      },
      update: () => ((f.upd = true), b),
      // Suporta a cadeia nova .insert(row).select('id').single() (C2).
      insert: (row: Record<string, unknown>) => {
        f.ins = row
        return {
          select: () => ({
            single: async () => {
              const key = `${row.conversation_id}|${row.message_id}`
              if (store.msgs.has(key)) return { data: null, error: { code: '23505' } }
              store.msgs.add(key); store.inserted++; store.lastInsert = row
              return { data: { id: `msg-${row.message_id}` }, error: null }
            },
          }),
        }
      },
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
        if (f.count) return { count: store.priorCustomerMsgCount, error: null }
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
  evoFetchMessages: async () => store.records,
  evoBase64FromMedia: async () => store.media,
  evoFetchGroupSubject: async () => 'Turma 2026',
}))

vi.mock('@/lib/whatsapp/inbound', () => ({
  findOrCreateContact: async () => ({ contact: { id: 'c1' }, wasCreated: store.wasCreated }),
  findOrCreateConversation: async () => ({ id: 'conv1', unread_count: 0 }),
  findOrCreateGroupConversation: async (...args: unknown[]) => {
    store.groupConvCalls.push(args)
    return { id: 'grp1', unread_count: 0 }
  },
}))

// Os 4 dispatchers — vi.fn() configuráveis via store; asserções via import.
vi.mock('@/lib/automations/engine', () => ({
  runAutomationsForTrigger: vi.fn(async () => { if (store.autoThrows) throw new Error('auto boom') }),
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => {
    if (store.flowThrows) throw new Error('flow boom')
    return { consumed: store.flowConsumed, outcome: 'x' }
  }),
}))
vi.mock('@/lib/ai-agent/dispatch', () => ({ dispatchInboundToAiAgent: vi.fn(async () => {}) }))
vi.mock('@/lib/transcription/dispatch', () => ({ dispatchTranscription: vi.fn(async () => {}) }))

import { GET } from './route'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiAgent } from '@/lib/ai-agent/dispatch'
import { dispatchTranscription } from '@/lib/transcription/dispatch'

function req(headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/whatsapp/evolution/cron', { headers })
}

// Records padrão (1:1): M1 inbound + M2 eco próprio (fromMe).
function defaultRecords() {
  return [
    { key: { id: 'M1', fromMe: false, remoteJid: '5521999990000@s.whatsapp.net' }, pushName: 'Aluna', messageType: 'conversation', message: { conversation: 'Oi' }, messageTimestamp: 1782670000 },
    { key: { id: 'M2', fromMe: true, remoteJid: '5521999990000@s.whatsapp.net' }, messageType: 'conversation', message: { conversation: 'eco meu' }, messageTimestamp: 1782670001 },
  ]
}

// Só o inbound M1 (sem o eco), p/ asserções de dispatch.
function inboundOnly() {
  return [
    { key: { id: 'M1', fromMe: false, remoteJid: '5521999990000@s.whatsapp.net' }, pushName: 'Aluna', messageType: 'conversation', message: { conversation: 'Olá mundo' }, messageTimestamp: 1782670000 },
  ]
}

beforeEach(() => {
  store.conns = [{ id: 'k1', account_id: 'a1', user_id: 'u1', instance_name: 'inst1', evolution_base_url: null, last_evo_timestamp: null }]
  store.records = defaultRecords()
  store.msgs = new Set()
  store.inserted = 0
  store.lastInsert = null
  store.groupConvCalls = []
  store.cursorUpdates = 0
  store.wasCreated = false
  store.priorCustomerMsgCount = 1
  store.flowConsumed = false
  store.flowThrows = false
  store.autoThrows = false
  store.media = null
  process.env.EVOLUTION_API_URL = 'http://evo.test:8080'
  process.env.EVOLUTION_API_KEY = 'k'
})
afterEach(() => { delete process.env.AUTOMATION_CRON_SECRET })

// Helper: triggers passados ao runAutomationsForTrigger.
function automationTriggers() {
  return vi.mocked(runAutomationsForTrigger).mock.calls.map((c) => (c[0] as { triggerType: string }).triggerType)
}

describe('GET /api/whatsapp/evolution/cron — auth + import', () => {
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
    expect(r1.imported).toBe(1)
    expect(store.inserted).toBe(1)

    store.conns[0].last_evo_timestamp = 1782670000
    const r2 = await (await GET(req({ 'x-cron-secret': 'certo' }))).json()
    expect(r2.imported).toBe(0)
    expect(store.inserted).toBe(1)
  })
})

describe('GET /api/whatsapp/evolution/cron — dispatch 1:1', () => {
  beforeEach(() => { process.env.AUTOMATION_CRON_SECRET = 'certo'; store.records = inboundOnly() })

  it('dispara flows + automações + IA (connectionId/contactId corretos)', async () => {
    await GET(req({ 'x-cron-secret': 'certo' }))
    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    expect(vi.mocked(dispatchInboundToFlows).mock.calls[0][0]).toMatchObject({
      accountId: 'a1', connectionId: 'k1', contactId: 'c1',
      message: { kind: 'text', text: 'Olá mundo', meta_message_id: 'M1' },
    })
    expect(automationTriggers()).toEqual(expect.arrayContaining(['new_message_received', 'keyword_match']))
    expect(vi.mocked(runAutomationsForTrigger).mock.calls[0][0]).toMatchObject({
      connectionId: 'k1', contactId: 'c1', context: { message_text: 'Olá mundo', conversation_id: 'conv1' },
    })
    expect(dispatchInboundToAiAgent).toHaveBeenCalledTimes(1)
  })

  it('C1: IA recebe inboundMessageId = wamid (M1), NÃO o UUID da linha', async () => {
    await GET(req({ 'x-cron-secret': 'certo' }))
    const arg = vi.mocked(dispatchInboundToAiAgent).mock.calls[0][0]
    expect(arg.inboundMessageId).toBe('M1')
    expect(arg.inboundMessageId).not.toBe('msg-M1')
  })

  it('first_inbound + new_contact disparam (ordem unshift à frente)', async () => {
    store.wasCreated = true
    store.priorCustomerMsgCount = 0
    await GET(req({ 'x-cron-secret': 'certo' }))
    const trg = automationTriggers()
    expect(trg).toContain('new_contact_created')
    expect(trg).toContain('first_inbound_message')
    // unshift coloca os relacionais antes dos de conteúdo.
    expect(trg.indexOf('first_inbound_message')).toBeLessThan(trg.indexOf('new_message_received'))
  })

  it('flowConsumed suprime content triggers; IA recebe flowConsumed=true', async () => {
    store.flowConsumed = true
    await GET(req({ 'x-cron-secret': 'certo' }))
    const trg = automationTriggers()
    expect(trg).not.toContain('new_message_received')
    expect(trg).not.toContain('keyword_match')
    expect(vi.mocked(dispatchInboundToAiAgent).mock.calls[0][0].flowConsumed).toBe(true)
  })

  it('áudio → dispatchTranscription com messageId = inserted.id (UUID) e db presente', async () => {
    store.records = [
      { key: { id: 'A1', fromMe: false, remoteJid: '5521999990000@s.whatsapp.net' }, pushName: 'Aluna', messageType: 'audioMessage', message: {}, messageTimestamp: 1782670000 },
    ]
    store.media = { base64: Buffer.from('audio').toString('base64'), mimetype: 'audio/ogg' }
    await GET(req({ 'x-cron-secret': 'certo' }))
    expect(dispatchTranscription).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(dispatchTranscription).mock.calls[0][0]
    expect(arg.messageId).toBe('msg-A1')
    expect(arg.db).toBeDefined()
  })
})

describe('GET /api/whatsapp/evolution/cron — grupo + resiliência', () => {
  beforeEach(() => { process.env.AUTOMATION_CRON_SECRET = 'certo' })

  it('grupo (@g.us) NÃO dispara nenhum engine (cria a conversa)', async () => {
    store.records = [
      { key: { id: 'G1', fromMe: false, remoteJid: '120363@g.us', participantAlt: '5521994593232@s.whatsapp.net' }, pushName: 'Camilla', messageType: 'conversation', message: { conversation: 'Oi grupo' }, messageTimestamp: 1782670500 },
    ]
    await GET(req({ 'x-cron-secret': 'certo' }))
    expect(store.groupConvCalls).toHaveLength(1)
    expect(dispatchInboundToFlows).not.toHaveBeenCalled()
    expect(runAutomationsForTrigger).not.toHaveBeenCalled()
    expect(dispatchInboundToAiAgent).not.toHaveBeenCalled()
    expect(dispatchTranscription).not.toHaveBeenCalled()
  })

  it('idempotência: 2x → dispatch só na 1ª', async () => {
    store.records = inboundOnly()
    await GET(req({ 'x-cron-secret': 'certo' }))
    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1)
    store.conns[0].last_evo_timestamp = 1782670000
    await GET(req({ 'x-cron-secret': 'certo' }))
    expect(dispatchInboundToFlows).toHaveBeenCalledTimes(1) // não disparou de novo
  })

  it('flows lança → cron não quebra e segue p/ automações', async () => {
    store.records = inboundOnly()
    store.flowThrows = true
    const r = await (await GET(req({ 'x-cron-secret': 'certo' }))).json()
    expect(r.imported).toBe(1)
    // flowConsumed=false no catch → content triggers ainda disparam.
    expect(automationTriggers()).toContain('new_message_received')
    expect(dispatchInboundToAiAgent).toHaveBeenCalledTimes(1)
  })

  it('automação fire-and-forget rejeita → import não quebra', async () => {
    store.records = inboundOnly()
    store.autoThrows = true
    const r = await (await GET(req({ 'x-cron-secret': 'certo' }))).json()
    expect(r.imported).toBe(1)
    expect(store.inserted).toBe(1)
  })
})
