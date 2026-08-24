import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder'
import type { MessageTemplate } from '@/types'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

export interface BroadcastResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

export interface BroadcastRecipientInput {
  phone: string
  /** Valores das variáveis do corpo, um por {{N}}. Campo legado. */
  params?: string[]
  /** Valores estruturados por envio (header/media/botões). Precedem `params`. */
  messageParams?: SendTimeParams
}

export interface SendRecipientsArgs {
  phoneNumberId: string
  accessToken: string
  templateName: string
  language: string
  /** Row do template (carregada e validada pelo chamador), p/ montar header/botões. */
  templateRow?: MessageTemplate | null
  recipients: BroadcastRecipientInput[]
}

/** Envios simultâneos por lote dentro de um tick do cron. */
const SEND_CONCURRENCY = 10

export interface SendRecipientsResult {
  results: BroadcastResult[]
  sentCount: number
  failedCount: number
}

/**
 * Dispara um lote de mensagens de template para uma lista de destinatários.
 * Núcleo de envio compartilhado entre POST /api/whatsapp/broadcast (envio
 * imediato, client-driven) e o send-engine do agendamento (server). Por
 * destinatário: sanitiza/valida o telefone, tenta variantes em erro
 * "não permitido" e envia via Meta. Não persiste nada — só envia e reporta.
 */
export async function sendRecipients(
  args: SendRecipientsArgs,
): Promise<SendRecipientsResult> {
  const {
    phoneNumberId,
    accessToken,
    templateName,
    language,
    templateRow,
    recipients,
  } = args

  // Envia um destinatário: sanitiza, valida e tenta as variantes do telefone.
  // Isolado em função para os envios rodarem em paralelo dentro do lote.
  async function enviaUm(recipient: BroadcastRecipientInput): Promise<BroadcastResult> {
    const sanitized = sanitizePhoneForMeta(recipient.phone)

    if (!isValidE164(sanitized)) {
      return {
        phone: recipient.phone,
        status: 'failed',
        error: 'Invalid phone number format',
      }
    }

    // Retry com variantes do telefone quando Meta responde "not in allowed
    // list" — números que diferem só num 0 de tronco ainda alcançam.
    const variants = phoneVariants(sanitized)
    let sentMessageId: string | null = null
    let lastError: string | null = null

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId,
          accessToken,
          to: variant,
          templateName,
          language,
          template: templateRow ?? undefined,
          messageParams: recipient.messageParams,
          params: recipient.params ?? [],
        })
        sentMessageId = result.messageId
        lastError = null
        break
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error'
        if (!isRecipientNotAllowedError(errorMessage)) {
          lastError = errorMessage
          break
        }
        lastError = errorMessage
        // tenta a próxima variante
      }
    }

    if (sentMessageId) {
      return {
        phone: recipient.phone,
        status: 'sent',
        whatsapp_message_id: sentMessageId,
      }
    }
    console.error(`Failed to send broadcast to ${recipient.phone}:`, lastError)
    return {
      phone: recipient.phone,
      status: 'failed',
      error: lastError || 'Unknown error',
    }
  }

  // Lotes de SEND_CONCURRENCY em paralelo, lotes em sequência. A ordem de
  // `results` espelha a de `recipients` — o send-engine casa resultado com
  // destinatário pelo índice. O teto existe para o pico ficar longe do limite
  // da Meta (80 msg/s) e não estourar sockets num tick grande.
  const results: BroadcastResult[] = []
  for (let i = 0; i < recipients.length; i += SEND_CONCURRENCY) {
    const chunk = recipients.slice(i, i + SEND_CONCURRENCY)
    results.push(...(await Promise.all(chunk.map(enviaUm))))
  }

  const sentCount = results.filter((r) => r.status === 'sent').length
  const failedCount = results.length - sentCount

  return { results, sentCount, failedCount }
}
