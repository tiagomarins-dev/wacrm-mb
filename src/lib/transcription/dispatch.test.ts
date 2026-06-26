import { describe, expect, it, vi, afterEach } from 'vitest'
import { dispatchTranscription } from './dispatch'
import { transcribeAudioBytes } from './transcribe'
import { formatTranscription } from './format'

// Mocks dos passos de rede e do decrypt — o foco é a orquestração.
vi.mock('./transcribe', () => ({ transcribeAudioBytes: vi.fn() }))
vi.mock('./format', () => ({ formatTranscription: vi.fn() }))
vi.mock('@/lib/whatsapp/encryption', () => ({ decrypt: (s: string) => s }))

// Mock chainable do supabase client. `maybeSingle` devolve cfg p/
// integrations_config e claimed p/ messages; toda update grava o patch.
function makeDb(opts: { cfg: unknown; claimed: unknown }) {
  const patches: { table: string; patch: Record<string, unknown> }[] = []
  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      in: () => b,
      update: (patch: Record<string, unknown>) => {
        patches.push({ table, patch })
        return b
      },
      maybeSingle: async () => ({
        data: table === 'integrations_config' ? opts.cfg : opts.claimed,
        error: null,
      }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    }
    return b
  }
  return { db: { from: (t: string) => builder(t) } as never, patches }
}

const enabledCfg = {
  transcription_enabled: true,
  transcription_model: null,
  transcription_fallback_model: null,
  transcription_format_model: null,
  openrouter_api_key: 'enc-key',
}

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('dispatchTranscription', () => {
  it('outbound: transcreve, formata e grava done', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })))
    vi.mocked(transcribeAudioBytes).mockResolvedValue({ rawText: 'oi', modelUsed: 'm', costUsd: 0.0005, latencyMs: 1 })
    vi.mocked(formatTranscription).mockResolvedValue({ makesSense: true, text: 'Oi!', costUsd: 0.0001 })

    const { db, patches } = makeDb({ cfg: enabledCfg, claimed: { id: 'm1', transcription_attempts: 0 } })
    await dispatchTranscription({
      db, messageId: 'm1', accountId: 'a1', conversationId: 'c1',
      mediaUrl: 'https://proj.supabase.co/storage/v1/object/public/chat-media/x.ogg',
    })

    // Claim marcou running e o terminal gravou done com o texto formatado.
    expect(patches.some((p) => p.patch.transcription_status === 'running')).toBe(true)
    const finalPatch = patches.find((p) => p.patch.transcription_status === 'done')
    expect(finalPatch?.patch.transcription).toBe('Oi!')
  })

  it('outbound vazio: grava empty + "Áudio sem conteúdo"', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proj.supabase.co')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 })))
    vi.mocked(transcribeAudioBytes).mockResolvedValue({ rawText: '', modelUsed: 'm', costUsd: 0, latencyMs: 1 })

    const { db, patches } = makeDb({ cfg: enabledCfg, claimed: { id: 'm1', transcription_attempts: 0 } })
    await dispatchTranscription({ db, messageId: 'm1', accountId: 'a1', conversationId: 'c1', mediaUrl: 'https://proj.supabase.co/x.ogg' })

    const finalPatch = patches.find((p) => p.patch.transcription_status === 'empty')
    expect(finalPatch?.patch.transcription).toBe('Áudio sem conteúdo')
  })

  it('skip quando transcription_enabled=false (não toca mensagem)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { db, patches } = makeDb({ cfg: { ...enabledCfg, transcription_enabled: false }, claimed: null })
    await dispatchTranscription({ db, messageId: 'm1', accountId: 'a1', conversationId: 'c1', mediaUrl: 'https://x/x.ogg' })

    expect(patches.length).toBe(0)
    expect(transcribeAudioBytes).not.toHaveBeenCalled()
  })

  it('skip quando não há openrouter_api_key', async () => {
    const { db, patches } = makeDb({ cfg: { ...enabledCfg, openrouter_api_key: null }, claimed: null })
    await dispatchTranscription({ db, messageId: 'm1', accountId: 'a1', conversationId: 'c1', mediaUrl: 'https://x/x.ogg' })
    expect(patches.length).toBe(0)
  })

  it('claim perdido (outro já pegou): não transcreve', async () => {
    const { db } = makeDb({ cfg: enabledCfg, claimed: null })
    await dispatchTranscription({ db, messageId: 'm1', accountId: 'a1', conversationId: 'c1', mediaUrl: 'https://x/x.ogg' })
    expect(transcribeAudioBytes).not.toHaveBeenCalled()
  })
})
