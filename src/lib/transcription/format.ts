// ============================================================
// Formatação/correção da transcrição crua via OpenRouter chat.
// Corrige pontuação/erros de ASR e julga se o áudio tem conteúdo.
// data_collection:'deny' é garantido no /chat/completions (espelha
// src/lib/integrations/openrouter.ts:114).
// ============================================================
import { DEFAULT_FORMAT_MODEL, FORMAT_SYSTEM_PROMPT } from './constants'

const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'

export interface FormatResult {
  makesSense: boolean
  text: string
  costUsd: number
}

// Formata/corrige a transcrição crua e julga se há conteúdo. JSON estrito.
// Guard: rawText vazio NUNCA chama o LLM (boundary) — economiza custo.
export async function formatTranscription(args: {
  apiKey: string
  rawText: string
  model?: string | null
}): Promise<FormatResult> {
  if (!args.rawText.trim()) return { makesSense: false, text: '', costUsd: 0 }

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
      'X-Title': 'wacrm',
    },
    body: JSON.stringify({
      model: args.model || DEFAULT_FORMAT_MODEL,
      messages: [
        { role: 'system', content: FORMAT_SYSTEM_PROMPT },
        { role: 'user', content: args.rawText },
      ],
      response_format: { type: 'json_object' },
      provider: { data_collection: 'deny' },
    }),
  })
  if (!res.ok) throw new Error(`format HTTP ${res.status}`)
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { cost?: number }
  }
  const costUsd = data.usage?.cost ?? 0
  // Parsing defensivo: JSON malformado -> trata como sem conteúdo.
  try {
    const parsed = JSON.parse(data.choices?.[0]?.message?.content ?? '{}') as {
      makesSense?: boolean
      text?: string
    }
    return { makesSense: parsed.makesSense === true, text: (parsed.text ?? '').trim(), costUsd }
  } catch {
    return { makesSense: false, text: '', costUsd }
  }
}
