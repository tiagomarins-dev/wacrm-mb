// ============================================================
// Client OpenRouter com tool-calling (loop) para o agente.
// Espelha o fetch de src/lib/integrations/openrouter.ts:100-117 (header
// Authorization Bearer, X-Title, provider.data_collection:'deny' — M2),
// mas adiciona `tools` e o loop de tool_calls. O LLM ROTEIA o assunto
// escolhendo qual ferramenta chama.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { ChatMsg } from './prompt'
import { buildToolDefs, execTool } from './tools'

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const TIMEOUT_MS = 60_000

export type AgentTopic = 'vendas' | 'suporte' | null

// Contexto passado ao loop e repassado às tools (carrega o que as tools
// precisam: db + ids da conta/conversa/contato + roteamento de handoff).
export interface AgentCtx {
  db: SupabaseClient
  accountId: string
  connectionId: string
  conversationId: string
  contactId: string
  model: string
  classifierModel: string | null
  maxTurns: number
  system: string
  messages: ChatMsg[]
  handoffRouting: Record<string, string> | null
}

// Resolve a chave do OpenRouter da conta (reusa integrations_config, já
// criptografada). Lança se não houver chave — o agente não roda sem ela.
export async function resolveOpenRouterKey(
  db: SupabaseClient,
  accountId: string,
): Promise<string> {
  const { data } = await db
    .from('integrations_config')
    .select('openrouter_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  const enc = (data as { openrouter_api_key: string | null } | null)?.openrouter_api_key
  if (!enc) throw new Error('OpenRouter API key não configurada para esta conta')
  return decrypt(enc)
}

// Roda o loop: chama o modelo, executa as tools pedidas, realimenta os
// resultados, até uma resposta final (sem tool_calls) ou estourar maxTurns.
export async function runAgentLoop(
  ctx: AgentCtx,
): Promise<{ reply: string | null; topic: AgentTopic; handoff: { to: string | null } | null }> {
  const apiKey = await resolveOpenRouterKey(ctx.db, ctx.accountId)
  const toolDefs = buildToolDefs()
  const msgs: ChatMsg[] = [{ role: 'system', content: ctx.system }, ...ctx.messages]
  let topic: AgentTopic = null
  let handoff: { to: string | null } | null = null

  for (let turn = 0; turn < ctx.maxTurns; turn++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
    let data: { choices?: { message?: ChatMsg }[] }
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'X-Title': 'wacrm',
        },
        body: JSON.stringify({
          model: ctx.model,
          messages: msgs,
          tools: toolDefs,
          tool_choice: 'auto',
          provider: { data_collection: 'deny' }, // M2: no-logging (PID do aluno)
        }),
        signal: controller.signal,
      })
      if (!res.ok) {
        console.error('[ai_agent] OpenRouter error', res.status)
        break
      }
      data = await res.json()
    } catch (err) {
      console.error('[ai_agent] OpenRouter request failed:', err instanceof Error ? err.message : err)
      break
    } finally {
      clearTimeout(timeout)
    }

    const choice = data?.choices?.[0]?.message
    if (!choice) break
    msgs.push(choice)

    const calls = choice.tool_calls ?? []
    // Sem tool_calls → resposta final do modelo.
    if (calls.length === 0) return { reply: choice.content ?? null, topic, handoff }

    // Executa cada tool pedida e realimenta o resultado (role:'tool').
    for (const call of calls) {
      const { output, detectedTopic, handoff: h } = await execTool(ctx, call)
      if (detectedTopic) topic = detectedTopic
      if (h) handoff = h // transferir_humano sinaliza; o engine aplica pós-envio
      msgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) })
    }
  }

  // Estourou maxTurns sem resposta final (trava anti-loop).
  return { reply: null, topic, handoff }
}
