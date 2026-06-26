// ============================================================
// STT via OpenRouter (/audio/transcriptions). Espelha o padrão de
// fetch/timeout/AbortController de src/lib/integrations/openrouter.ts.
// ============================================================
import { DEFAULT_STT_PRIMARY, DEFAULT_STT_FALLBACK } from './constants'

const STT_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'
const TIMEOUT_MS = 60_000

export interface TranscribeArgs {
  apiKey: string
  /** Bytes do áudio em base64 cru (sem data URI). */
  base64: string
  /** Formato aceito pelo endpoint: ogg | mp3 | m4a | aac | wav | webm. */
  format: string
  primaryModel?: string | null
  fallbackModel?: string | null
}
export interface TranscribeResult {
  rawText: string
  modelUsed: string
  costUsd: number
  latencyMs: number
}

// Chama um modelo STT do OpenRouter. Lança em erro/HTTP-not-ok.
// provider.data_collection:'deny' é best-effort no STT (a doc do endpoint
// NÃO garante no-logging como no /chat/completions) — ressalva R1.
async function callStt(apiKey: string, model: string, base64: string, format: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const t0 = Date.now()
  try {
    const res = await fetch(STT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'wacrm',
      },
      body: JSON.stringify({
        model,
        input_audio: { data: base64, format },
        language: 'pt',
        provider: { data_collection: 'deny' },
      }),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`STT ${model} HTTP ${res.status}`)
    const data = (await res.json()) as { text?: string; usage?: { cost?: number } }
    return {
      rawText: (data.text ?? '').trim(),
      costUsd: data.usage?.cost ?? 0,
      latencyMs: Date.now() - t0,
    }
  } finally {
    clearTimeout(timeout)
  }
}

// Tenta o modelo primário; em erro OU texto vazio, cai no fallback.
export async function transcribeAudioBytes(args: TranscribeArgs): Promise<TranscribeResult> {
  const primary = args.primaryModel || DEFAULT_STT_PRIMARY
  const fallback = args.fallbackModel || DEFAULT_STT_FALLBACK
  try {
    const r = await callStt(args.apiKey, primary, args.base64, args.format)
    if (r.rawText) return { ...r, modelUsed: primary }
  } catch (e) {
    console.error('[transcription] STT primário falhou:', (e as Error).message)
  }
  const r = await callStt(args.apiKey, fallback, args.base64, args.format)
  return { ...r, modelUsed: fallback }
}
