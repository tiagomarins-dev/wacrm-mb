// ============================================================
// intent-cron.ts — worker (I/O) que classifica a INTENÇÃO da conversa via LLM.
// Preenche conversations.report_intent (eleva confidence da atribuição de venda
// quando ai_topic é null). Regra de parse é pura (openrouter.parseIntent).
// Cadência: 1x/dia (no-op temporal). PII redigida antes de ir ao LLM.
// ============================================================
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { classifyIntent } from '@/lib/integrations/openrouter'
import { redactPII } from '@/lib/integrations/redact'

const NO_OP_HOURS = 20
const CAP_PER_RUN = 300     // teto de conversas/conta por execução
const BATCH = 5             // chamadas LLM em paralelo por lote
const WINDOW_DAYS = 30      // só conversas com atividade recente

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Msg = { sender_type: 'customer' | 'agent' | 'bot'; content_text: string | null; content_type: string | null }

// Classifica as conversas pendentes (report_intent IS NULL) de uma conta.
async function processAccount(acc: string, encKey: string | null): Promise<{ classified: number; errors: number }> {
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

  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString()
  const { data: convs } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', acc)
    .is('report_intent', null)
    .gte('last_message_at', cutoff)
    .order('last_message_at', { ascending: false })
    .limit(CAP_PER_RUN)
  const ids = ((convs as { id: string }[] | null) ?? []).map((c) => c.id)
  if (ids.length === 0) return { classified: 0, errors: 0 }

  let classified = 0, errors = 0
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
      try {
        const intent = await classifyIntent({ apiKey: key as string, messages: safe })
        if (intent) {
          await db.from('conversations').update({ report_intent: intent, report_intent_at: new Date().toISOString() }).eq('id', convId)
          classified++
        }
        // intent null → degrada (não grava; tenta de novo no próximo run)
      } catch {
        errors++ // falha de rede/LLM — sem retry (não amplifica)
      }
    }))
    await sleep(300)
  }

  await db.from('intent_cron_runs').insert({ account_id: acc, classified, errors })
  return { classified, errors }
}

// Entrada do worker: no-op temporal + varre contas com key OpenRouter.
export async function runIntentCron(): Promise<{ skipped?: boolean; accounts?: number; classified?: number }> {
  const db = supabaseAdmin()
  const { data: last } = await db.from('intent_cron_runs').select('ran_at').order('ran_at', { ascending: false }).limit(1)
  const lastAt = (last as { ran_at: string }[] | null)?.[0]?.ran_at
  if (lastAt && Date.now() - new Date(lastAt).getTime() < NO_OP_HOURS * 3_600_000) {
    return { skipped: true }
  }

  const { data: cfgs } = await db
    .from('integrations_config')
    .select('account_id, openrouter_api_key')
    .not('openrouter_api_key', 'is', null)
  const rows = (cfgs as { account_id: string; openrouter_api_key: string | null }[] | null) ?? []

  let classified = 0
  for (const cfg of rows) {
    const r = await processAccount(cfg.account_id, cfg.openrouter_api_key)
    classified += r.classified
  }
  return { accounts: rows.length, classified }
}
