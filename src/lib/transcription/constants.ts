// ============================================================
// Constantes da transcrição automática de áudio (migration 046).
// Os modelos default foram escolhidos por benchmark real em PT
// (8 modelos via OpenRouter). Override por conta vem de
// integrations_config.transcription_* ; estes são o fallback.
// ============================================================

/** STT primário — Groq Whisper Turbo (rápido + barato + qualidade). */
export const DEFAULT_STT_PRIMARY = 'openai/whisper-large-v3-turbo'
/** STT fallback — OpenAI, usado quando o primário falha/retorna vazio. */
export const DEFAULT_STT_FALLBACK = 'openai/gpt-4o-mini-transcribe'
/** Modelo de chat que corrige/formata o texto e julga se há conteúdo. */
export const DEFAULT_FORMAT_MODEL = 'openai/gpt-4o-mini'

/** Teto de tentativas do cron antes de desistir de uma linha. */
export const MAX_ATTEMPTS = 3
/** Janela da mídia inbound na Meta (expira ~24h); cron não tenta além disto. */
export const MEDIA_MAX_WINDOW_H = 23
/** Teto de bytes do áudio antes de gastar STT (Whisper aceita ~25MB). */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024

/** Texto gravado quando o áudio não tem fala compreensível. */
export const AUDIO_NO_CONTENT = 'Áudio sem conteúdo'

/** Prompt PT da etapa de formatação/correção + julgamento de conteúdo. */
export const FORMAT_SYSTEM_PROMPT =
  'Você recebe a transcrição crua de um áudio de WhatsApp em português. ' +
  'Corrija pontuação, capitalização e erros óbvios de transcrição, preservando ' +
  'EXATAMENTE o sentido. NÃO invente, NÃO resuma, NÃO adicione informação. ' +
  'Se o áudio não tiver fala compreensível (ruído, silêncio, ininteligível), ' +
  'responda makesSense=false. Responda SOMENTE JSON: {"makesSense": boolean, "text": string}.'
