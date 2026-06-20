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

  const results: BroadcastResult[] = []
  let sentCount = 0
  let failedCount = 0

  for (const recipient of recipients) {
    const sanitized = sanitizePhoneForMeta(recipient.phone)

    if (!isValidE164(sanitized)) {
      results.push({
        phone: recipient.phone,
        status: 'failed',
        error: 'Invalid phone number format',
      })
      failedCount++
      continue
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
      results.push({
        phone: recipient.phone,
        status: 'sent',
        whatsapp_message_id: sentMessageId,
      })
      sentCount++
    } else {
      console.error(`Failed to send broadcast to ${recipient.phone}:`, lastError)
      results.push({
        phone: recipient.phone,
        status: 'failed',
        error: lastError || 'Unknown error',
      })
      failedCount++
    }
  }

  return { results, sentCount, failedCount }
}
