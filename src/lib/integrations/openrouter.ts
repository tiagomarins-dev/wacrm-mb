// ============================================================
// OpenRouter — resumo de conversa para compartilhar (Notion/Slack).
// PII minimizada: só mensagens + assunto (+1º nome opcional) vão ao LLM.
// Email/telefone/nome completo NUNCA entram aqui (anexados depois, no
// servidor, via contact-block). data_collection:'deny' = no-logging.
// ============================================================
import type { IntentLabel, LossReasonLabel, MotivoLabel } from '@/types'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-4o-mini'
const TIMEOUT_MS = 30_000

/** Quantas mensagens do fim da conversa entram no resumo. */
export const SHARE_MESSAGE_LIMIT = 30

/** Teto de mensagens do briefing (conversa "toda", com trava de custo/token). */
export const BRIEFING_MESSAGE_LIMIT = 500

// Prompt dedicado do briefing (handoff p/ novo atendente). Estrutura fixa —
// diferente do resumo de compartilhar (DEFAULT_SUMMARY_PROMPT).
export const BRIEFING_SUMMARY_PROMPT =
  'Você é um assistente de atendimento. Gere um BRIEFING da conversa abaixo para ' +
  'um NOVO atendente assumir, em português, objetivo. Estruture em tópicos: ' +
  '1) Resumo em 1 linha; 2) O que o cliente quer / relatou; 3) O que já foi ' +
  'feito/respondido; 4) O que foi PROMETIDO ao cliente (prazos, valores, retornos); ' +
  '5) Pendências / próximo passo; 6) Tom e urgência do cliente. ' +
  'Use só o que está na conversa — NÃO invente dados. Se algo não apareceu, escreva "não informado".'

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
  /** Nº máx. de mensagens (do fim) no resumo. Default SHARE_MESSAGE_LIMIT. */
  messageLimit?: number
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
  const { apiKey, model, systemPrompt, messages, topic, firstName, messageLimit } = args
  const transcript = serializeMessages(messages, messageLimit ?? SHARE_MESSAGE_LIMIT)
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

// ── Classificador de intenção (Fase 3 dos relatórios) ───────
const CLASSIFY_PROMPT =
  'Classifique a intenção primária da conversa abaixo em UMA palavra: ' +
  '"vendas" (cliente quer comprar/matricular), "suporte" (dúvida/problema de quem já é aluno) ' +
  'ou "outro". Responda só a palavra, sem pontuação.'

/**
 * Parse PURO da resposta do LLM (esperado 1 palavra) para o enum de intenção.
 * Fora do enum / vazio → null (degrada: não grava nada).
 */
export function parseIntent(text: string | null | undefined): IntentLabel | null {
  const t = (text ?? '').toLowerCase()
  if (t.includes('venda')) return 'vendas'
  if (t.includes('suporte')) return 'suporte'
  if (t.includes('outro')) return 'outro'
  return null
}

/**
 * Classifica a intenção primária da conversa. Reusa o mesmo padrão de fetch do
 * resumo (Bearer, X-Title, timeout, data_collection:'deny'); max_tokens baixo
 * (resposta = 1 palavra). O caller deve ter redigido PII das mensagens antes.
 * Lança em erro/timeout (sem vazar token).
 */
export async function classifyIntent(args: {
  apiKey: string
  model?: string | null
  messages: SummaryMessage[]
}): Promise<IntentLabel | null> {
  const transcript = serializeMessages(args.messages)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'wacrm',
      },
      body: JSON.stringify({
        model: args.model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: CLASSIFY_PROMPT },
          { role: 'user', content: transcript },
        ],
        max_tokens: 4,
        provider: { data_collection: 'deny' },
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('OpenRouter timed out')
    throw new Error('OpenRouter request failed')
  } finally {
    clearTimeout(timeout)
  }
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}`)
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return parseIntent(data?.choices?.[0]?.message?.content)
}

// ── Classificação COMPLETA (F2): intent + motivo + loss_reason + flags, em JSON ──
const CLASSIFY_FULL_PROMPT =
  'Analise a conversa de WhatsApp abaixo e responda APENAS um JSON válido, sem texto extra, no formato: ' +
  '{"intent":"vendas|suporte|outro",' +
  '"motivo":"duvida_uso|financeiro|erro_bug|reclamacao|outro"|null,' +
  '"loss_reason":"preco|vai_decidir|concorrente|parou_responder|nao_perdida"|null,' +
  '"flags":{"sentimento_negativo":boolean,"oportunidade_venda":boolean}}. ' +
  'Regras: "intent" é a intenção primária (vendas = quer comprar/matricular; suporte = dúvida/problema de aluno). ' +
  '"motivo" SÓ quando intent=suporte (senão null): duvida_uso (uso da plataforma/curso), financeiro (cobrança/pagamento), ' +
  'erro_bug (algo não funciona), reclamacao, outro. ' +
  '"loss_reason" SÓ quando intent=vendas (senão null): preco, vai_decidir (adiou), concorrente, ' +
  'parou_responder (sumiu), nao_perdida (comprou ou negociação em andamento). ' +
  '"sentimento_negativo": true se o cliente demonstra insatisfação forte/risco de cancelamento. ' +
  '"oportunidade_venda": true se, numa conversa de suporte, o cliente pediu/perguntou sobre comprar algo.'

// Resultado da classificação completa. flags SEM aguardando_resposta (o worker
// calcula determinístico a partir da última mensagem e injeta na gravação).
export interface ConversationClassification {
  intent: IntentLabel
  motivo: MotivoLabel | null
  loss_reason: LossReasonLabel | null
  flags: { sentimento_negativo: boolean; oportunidade_venda: boolean }
}

const MOTIVOS = new Set(['duvida_uso', 'financeiro', 'erro_bug', 'reclamacao', 'outro'])
const LOSS = new Set(['preco', 'vai_decidir', 'concorrente', 'parou_responder', 'nao_perdida'])

/**
 * Parse PURO e defensivo do JSON do LLM (espelha format.ts). JSON inválido ou
 * intent fora do enum → null (degrada, não grava). Campo inválido → null só no
 * campo (não derruba o resto). Cross-field imposto AQUI (defense in depth):
 * motivo só com intent=suporte; loss_reason só com intent=vendas. flags: só
 * booleans coagidos (===true) nas chaves conhecidas — nunca o objeto cru.
 */
export function parseClassification(text: string | null | undefined): ConversationClassification | null {
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const intent = parseIntent(typeof o.intent === 'string' ? o.intent : null)
  if (!intent) return null
  const motivo =
    intent === 'suporte' && typeof o.motivo === 'string' && MOTIVOS.has(o.motivo)
      ? (o.motivo as MotivoLabel)
      : null
  const loss =
    intent === 'vendas' && typeof o.loss_reason === 'string' && LOSS.has(o.loss_reason)
      ? (o.loss_reason as LossReasonLabel)
      : null
  const f = (typeof o.flags === 'object' && o.flags !== null ? o.flags : {}) as Record<string, unknown>
  return {
    intent,
    motivo,
    loss_reason: loss,
    flags: {
      sentimento_negativo: f.sentimento_negativo === true,
      oportunidade_venda: f.oportunidade_venda === true,
    },
  }
}

/**
 * Classificação completa da conversa (intent+motivo+loss+flags) em UMA chamada,
 * com resposta JSON forçada (response_format). Devolve também os tokens
 * consumidos (p/ intent_cron_runs.tokens). O caller já redigiu PII.
 */
export async function classifyConversation(args: {
  apiKey: string
  model?: string | null
  messages: SummaryMessage[]
}): Promise<{ result: ConversationClassification | null; tokens: number }> {
  const transcript = serializeMessages(args.messages)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'wacrm',
      },
      body: JSON.stringify({
        model: args.model || DEFAULT_MODEL,
        messages: [
          { role: 'system', content: CLASSIFY_FULL_PROMPT },
          { role: 'user', content: transcript },
        ],
        max_tokens: 200,
        response_format: { type: 'json_object' },
        provider: { data_collection: 'deny' },
      }),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('OpenRouter timed out')
    throw new Error('OpenRouter request failed')
  } finally {
    clearTimeout(timeout)
  }
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}`)
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { total_tokens?: number }
  }
  return {
    result: parseClassification(data?.choices?.[0]?.message?.content),
    tokens: data?.usage?.total_tokens ?? 0,
  }
}
