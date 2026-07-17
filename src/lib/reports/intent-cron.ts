// ============================================================
// intent-cron.ts — worker (I/O) da CLASSIFICAÇÃO COMPLETA da conversa via LLM
// (068): report_intent + report_motivo + report_loss_reason + report_flags.
// A flag aguardando_resposta é DETERMINÍSTICA (última msg do cliente) — não
// gasta token. Regra de parse é pura (openrouter.parseClassification).
// Cadência: 1x/dia (no-op temporal); modo backfill pula o no-op e aceita
// janela/cap próprios (análise retroativa). PII redigida antes de ir ao LLM.
// ============================================================
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { classifyConversation } from '@/lib/integrations/openrouter'
import { redactPII } from '@/lib/integrations/redact'

const NO_OP_HOURS = 20
const CAP_PER_RUN = 300     // teto de conversas/conta por execução
const BATCH = 5             // chamadas LLM em paralelo por lote
const WINDOW_DAYS = 30      // só conversas com atividade recente

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Msg = { sender_type: 'customer' | 'agent' | 'bot'; content_text: string | null; content_type: string | null }

// Opções do worker: backfill pula o no-op de 20h; windowDays/cap sobrepõem os
// defaults (análise retroativa chama com janela ampla e cap menor por chamada).
export type IntentCronOpts = { backfill?: boolean; windowDays?: number; cap?: number }

// Classifica as conversas pendentes da taxonomia v1 de uma conta.
async function processAccount(
  acc: string,
  encKey: string | null,
  opts: IntentCronOpts = {},
): Promise<{ classified: number; errors: number }> {
  const db = supabaseAdmin()
  // key OpenRouter: decripta (catch → null) + fallback env. Nunca logada.
  let key: string | null = null
  try {
    key = encKey ? decrypt(encKey) : null
  } catch {
    key = null
  }
  key = key ?? process.env.OPENROUTER_API_KEY ?? null
  if (!key) return { classified: 0, errors: 0 }

  const windowDays = opts.windowDays ?? WINDOW_DAYS
  const cap = opts.cap ?? CAP_PER_RUN
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString()
  // Pendentes da taxonomia v1 (novas E antigas do v0). ⚠️ `.or` obrigatório —
  // `.neq` sozinho NÃO pega NULL; predicado casa com o índice parcial da 068.
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', acc)
    .or('report_taxonomy_version.is.null,report_taxonomy_version.neq.1')
    .gte('last_message_at', cutoff)
    .order('last_message_at', { ascending: false })
    .limit(cap)
  const ids = ((convs as { id: string }[] | null) ?? []).map((c) => c.id)
  if (ids.length === 0) return { classified: 0, errors: 0 }

  let classified = 0, errors = 0, tokens = 0
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    await Promise.all(slice.map(async (convId) => {
      // últimas mensagens da conversa (texto + tipo), ordem cronológica
      const { data: rows } = await db
        .from('messages')
        .select('sender_type, content_text, content_type')
        .eq('conversation_id', convId)
        .order('created_at', { ascending: true })
        .limit(30)
      const msgs = ((rows as Msg[] | null) ?? [])
      if (msgs.length === 0) return
      // ⚠️ redige PII (email/telefone) ANTES de montar o transcript do LLM
      const safe = msgs.map((m) => ({
        sender_type: m.sender_type,
        content_text: m.content_text ? redactPII(m.content_text) : m.content_text,
        content_type: m.content_type ?? undefined,
      }))
      // aguardando_resposta: determinística (última msg é do cliente) — fora do LLM.
      const aguardando = msgs[msgs.length - 1]?.sender_type === 'customer'
      try {
        const { result, tokens: t } = await classifyConversation({ apiKey: key as string, messages: safe })
        tokens += t
        if (result) {
          await db.from('conversations').update({
            report_intent: result.intent, // G4: pode trocar o v0 (taxonomia melhor)
            report_intent_at: new Date().toISOString(),
            report_motivo: result.motivo,
            report_loss_reason: result.loss_reason,
            report_flags: { ...result.flags, aguardando_resposta: aguardando },
            report_taxonomy_version: 1,
          }).eq('id', convId)
          classified++
        }
        // result null → degrada (não grava; tenta de novo no próximo run)
      } catch {
        errors++ // falha de rede/LLM — sem retry (não amplifica)
      }
    }))
    await sleep(300)
  }

  // tokens agora preenchido (053:24 existia zerada). Runs de backfill entram
  // aqui também (G2): misturam na telemetria e disparam o no-op do cron diário.
  await db.from('intent_cron_runs').insert({ account_id: acc, classified, errors, tokens })
  return { classified, errors }
}

// Entrada do worker: no-op temporal (pulado no backfill) + varre contas com key OpenRouter.
export async function runIntentCron(
  opts: IntentCronOpts = {},
): Promise<{ skipped?: boolean; accounts?: number; classified?: number }> {
  const db = supabaseAdmin()
  if (!opts.backfill) {
    const { data: last } = await db.from('intent_cron_runs').select('ran_at').order('ran_at', { ascending: false }).limit(1)
    const lastAt = (last as { ran_at: string }[] | null)?.[0]?.ran_at
    if (lastAt && Date.now() - new Date(lastAt).getTime() < NO_OP_HOURS * 3_600_000) {
      return { skipped: true }
    }
  }

  const { data: cfgs } = await db
    .from('integrations_config')
    .select('account_id, openrouter_api_key')
    .not('openrouter_api_key', 'is', null)
  const rows = (cfgs as { account_id: string; openrouter_api_key: string | null }[] | null) ?? []

  let classified = 0
  for (const cfg of rows) {
    const r = await processAccount(cfg.account_id, cfg.openrouter_api_key, opts)
    classified += r.classified
  }
  return { accounts: rows.length, classified }
}
