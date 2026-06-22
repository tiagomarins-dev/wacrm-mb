// ============================================================
// Registro de clique em link enviado pelo AGENTE DE IA (token source='agent',
// sem flow_run). Espelha o insert de link_clicks de resumeRunOnLinkClick
// (flows/engine.ts:1250), mas com flow_run_id=null, source='agent'. NÃO
// retoma flow nenhum. connection_id é resolvido do contato (o token não
// carrega connection_id; link_clicks.connection_id é nullable).
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ConsumedToken } from './token'

// Insere a auditoria do clique do agente em link_clicks. Best-effort: nunca
// bloqueia o redirect (o caller já trata o try/catch da rota /r).
export async function recordAgentClick(
  db: SupabaseClient,
  payload: ConsumedToken,
  userAgent: string | null,
): Promise<void> {
  // connection_id da conexão do contato (analytics por número). Opcional —
  // a coluna é nullable; se o contato sumiu, grava null.
  let connectionId: string | null = null
  if (payload.contact_id) {
    const { data: contact } = await db
      .from('contacts')
      .select('connection_id')
      .eq('id', payload.contact_id)
      .eq('account_id', payload.account_id)
      .maybeSingle()
    connectionId = (contact as { connection_id: string | null } | null)?.connection_id ?? null
  }

  const { error } = await db.from('link_clicks').insert({
    account_id: payload.account_id,
    connection_id: connectionId,
    contact_id: payload.contact_id,
    flow_run_id: null,
    node_key: 'agent',
    source: 'agent',
    target_url: payload.url,
    user_agent: userAgent,
    is_sale: false,
  })
  if (error) console.error('[link] agent click insert failed:', error.message)
}
