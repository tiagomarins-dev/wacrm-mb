// ============================================================
// OpenRouter — resumo de conversa para compartilhar (Notion/Slack).
// PII minimizada: só mensagens + assunto (+1º nome opcional) vão ao LLM.
// Email/telefone/nome completo NUNCA entram aqui (anexados depois, no
// servidor, via contact-block). data_collection:'deny' = no-logging.
// ============================================================

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-4o-mini'
const TIMEOUT_MS = 30_000

/** Quantas mensagens do fim da conversa entram no resumo. */
export const SHARE_MESSAGE_LIMIT = 30

export const DEFAULT_SUMMARY_PROMPT =
  'Você é um assistente de atendimento. Resuma a conversa abaixo de forma ' +
  'objetiva e em português, focando no ASSUNTO informado. Liste: (1) o que o ' +
  'cliente relatou, (2) o que já foi feito/respondido, (3) o que falta / ' +
  'próximo passo. Seja conciso (até ~8 linhas). Não invente dados.'

/** Mensagem mínima que o resumo precisa (subset de Message). */
export interface SummaryMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text?: string | null
  content_type?: string
}

export interface SummarizeArgs {
  apiKey: string
  model?: string | null
  systemPrompt?: string | null
  messages: SummaryMessage[]
  topic: string
  /** Opcional — só o 1º nome, para personalizar ("Tiago relatou…"). */
  firstName?: string | null
}

/**
 * Serializa as últimas N mensagens em texto. Conteúdo não-texto vira
 * placeholder ([imagem]/[documento]/…) para não enviar URLs/lixo ao LLM.
 */
export function serializeMessages(
  messages: SummaryMessage[],
  limit = SHARE_MESSAGE_LIMIT,
): string {
  const tail = messages.slice(-limit)
  return tail
    .map((m) => {
      const who =
        m.sender_type === 'customer'
          ? 'Cliente'
          : m.sender_type === 'agent'
            ? 'Atendente'
            : 'Bot'
      let body = m.content_text?.trim()
      if (!body) {
        const t = m.content_type
        body =
          t === 'image'
            ? '[imagem]'
            : t === 'document'
              ? '[documento]'
              : t === 'audio'
                ? '[áudio]'
                : t === 'video'
                  ? '[vídeo]'
                  : t === 'location'
                    ? '[localização]'
                    : t === 'template'
                      ? '[template]'
                      : '[mensagem]'
      }
      return `${who}: ${body}`
    })
    .join('\n')
}

/**
 * Chama o OpenRouter e devolve o resumo. Lança Error com mensagem
 * tratada em falha/timeout (sem vazar token).
 */
export async function summarizeConversation(args: SummarizeArgs): Promise<string> {
  const { apiKey, model, systemPrompt, messages, topic, firstName } = args
  const transcript = serializeMessages(messages)
  const sys = systemPrompt?.trim() || DEFAULT_SUMMARY_PROMPT
  const userContent = [
    `Assunto: ${topic}`,
    firstName ? `Primeiro nome do cliente: ${firstName}` : null,
    '',
    'Conversa:',
    transcript,
  ]
    .filter((l) => l !== null)
    .join('\n')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'wacrm',
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: userContent },
        ],
        // No-logging: pede aos provedores para não reter o conteúdo.
        provider: { data_collection: 'deny' },
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('OpenRouter timed out')
    }
    throw new Error('OpenRouter request failed')
  } finally {
    clearTimeout(timeout)
  }

  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: { message?: string } }
      detail = body?.error?.message ?? ''
    } catch {
      // resposta não-JSON — ignora
    }
    throw new Error(`OpenRouter error ${res.status}${detail ? `: ${detail}` : ''}`)
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = data?.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('OpenRouter returned an empty summary')
  return text
}
