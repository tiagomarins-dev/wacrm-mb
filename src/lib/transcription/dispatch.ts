// ============================================================
// Orquestrador da transcrição de UMA mensagem de áudio (inbound ou
// outbound). Chamado fire-and-forget pelos gatilhos (webhook/send) e
// pelo cron de retry. Concentra: claim atômico, 2 caminhos de bytes
// (token Meta vs http do bucket), derivação de format, parse de mediaId,
// allowlist anti-SSRF, cap de tamanho, account-scope sob admin client,
// e no-log de segredo.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { resolveOutboundConfigForConversation } from '@/lib/connections/resolve'
import { transcribeAudioBytes } from './transcribe'
import { formatTranscription } from './format'
import { MAX_AUDIO_BYTES, AUDIO_NO_CONTENT } from './constants'

export interface DispatchArgs {
  db: SupabaseClient
  messageId: string
  accountId: string
  conversationId: string
  connectionId?: string | null
  mediaUrl: string
}

/** Subset da config lida do banco. */
interface TranscriptionConfig {
  transcription_enabled: boolean | null
  transcription_model: string | null
  transcription_fallback_model: string | null
  transcription_format_model: string | null
  openrouter_api_key: string | null
}

// Mapeia o mime (Meta/bucket) -> o `format` que o STT aceita.
// Aceitos: wav, mp3, flac, m4a, ogg, webm, aac. (amr NÃO é aceito.)
function mimeToFormat(mime: string | null | undefined): string {
  const m = (mime ?? '').toLowerCase()
  if (m.includes('ogg')) return 'ogg'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('m4a') || m.includes('mp4')) return 'm4a'
  if (m.includes('aac')) return 'aac'
  if (m.includes('webm')) return 'webm'
  if (m.includes('wav')) return 'wav'
  return 'ogg' // default seguro p/ nota de voz WhatsApp
}

// Grava resultado terminal somando a tentativa. `attempts` vem do claim —
// seguro porque o claim serializa o processamento desta linha.
async function done(
  db: SupabaseClient,
  id: string,
  attempts: number,
  status: 'done' | 'empty',
  text: string,
) {
  await db
    .from('messages')
    .update({ transcription: text, transcription_status: status, transcription_attempts: attempts + 1 })
    .eq('id', id)
}
async function failAttempt(db: SupabaseClient, id: string, attempts: number) {
  await db
    .from('messages')
    .update({ transcription_status: 'failed', transcription_attempts: attempts + 1 })
    .eq('id', id)
}

// Orquestra a transcrição. Fire-and-forget: nunca lança pra fora.
export async function dispatchTranscription(args: DispatchArgs): Promise<void> {
  const { db, messageId, accountId, conversationId, mediaUrl } = args
  try {
    // (1) Config da conta. Admin client bypassa RLS -> filtra account_id.
    const { data } = await db
      .from('integrations_config')
      .select(
        'transcription_enabled, transcription_model, transcription_fallback_model, transcription_format_model, openrouter_api_key',
      )
      .eq('account_id', accountId)
      .maybeSingle()
    const cfg = data as TranscriptionConfig | null
    if (!cfg || cfg.transcription_enabled === false || !cfg.openrouter_api_key) return
    const apiKey = decrypt(cfg.openrouter_api_key) // mesmo decrypt de resolveOpenRouterKey (llm.ts:54)

    // (2) CLAIM atômico — lock único compartilhado com o cron. Escreve em
    // transcription_status (NUNCA messages.status, que tem CHECK rígido).
    const { data: claimed } = await db
      .from('messages')
      .update({ transcription_status: 'running' })
      .eq('id', messageId)
      .in('transcription_status', ['pending', 'failed'])
      .select('id, transcription_attempts')
      .maybeSingle()
    if (!claimed) return // outro processo já pegou
    const attempts = ((claimed as { transcription_attempts: number }).transcription_attempts) ?? 0

    // (3) Bytes do áudio — dois caminhos.
    let buffer: Buffer
    let format: string
    if (mediaUrl.startsWith('/api/whatsapp/media/')) {
      // INBOUND — baixa da Meta com o token da CONEXÃO da conversa.
      const mediaId = mediaUrl.split('/api/whatsapp/media/')[1].split('?')[0]
      const conn = await resolveOutboundConfigForConversation(db, accountId, conversationId)
      const accessToken = decrypt(conn.access_token)
      const info = await getMediaUrl({ mediaId, accessToken })
      const dl = await downloadMedia({ downloadUrl: info.url, accessToken })
      buffer = dl.buffer
      format = mimeToFormat(dl.contentType || info.mimeType)
    } else {
      // OUTBOUND — bucket público. Allowlist de host por igualdade EXATA
      // (não startsWith/includes, que evil-supabase.co burlaria) — anti-SSRF.
      const supaHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).host
      if (new URL(mediaUrl).host !== supaHost) {
        await failAttempt(db, messageId, attempts)
        return
      }
      const res = await fetch(mediaUrl)
      if (!res.ok) {
        await failAttempt(db, messageId, attempts)
        return
      }
      buffer = Buffer.from(await res.arrayBuffer())
      format = 'ogg' // composer grava sempre audio/ogg (message-composer.tsx:353)
    }
    // Cap de tamanho antes de gastar STT.
    if (buffer.length > MAX_AUDIO_BYTES) {
      await failAttempt(db, messageId, attempts)
      return
    }

    // (4) STT (primário -> fallback).
    const stt = await transcribeAudioBytes({
      apiKey,
      base64: buffer.toString('base64'),
      format,
      primaryModel: cfg.transcription_model,
      fallbackModel: cfg.transcription_fallback_model,
    })
    if (!stt.rawText) {
      await done(db, messageId, attempts, 'empty', AUDIO_NO_CONTENT)
      return
    }

    // (5) Formatação/correção + julgamento.
    const fmt = await formatTranscription({
      apiKey,
      rawText: stt.rawText,
      model: cfg.transcription_format_model,
    })
    const costUsd = stt.costUsd + fmt.costUsd
    console.log(`[transcription] msg=${messageId} model=${stt.modelUsed} cost=$${costUsd.toFixed(6)}`)
    if (!fmt.makesSense || !fmt.text) {
      await done(db, messageId, attempts, 'empty', AUDIO_NO_CONTENT)
      return
    }

    // (6) Sucesso.
    await done(db, messageId, attempts, 'done', fmt.text)
  } catch (e) {
    // Nunca loga bytes/token — só a mensagem (padrão media/[mediaId]/route.ts:62).
    console.error('[transcription] dispatch falhou:', (e as Error).message)
    await db
      .from('messages')
      .update({ transcription_status: 'failed' })
      .eq('id', messageId)
      .then(
        () => {},
        () => {},
      )
  }
}
