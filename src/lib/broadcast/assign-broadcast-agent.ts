import type { SupabaseClient } from '@supabase/supabase-js'

/** Janela de elegibilidade: template enviado há até 7 dias. */
const ASSIGN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Atribui a conversa ao perfil de IA da campanha quando o lead responde a um
 * broadcast com agente vinculado. Regras:
 * - Recipient mais recente do contato com template já enviado (status
 *   sent/delivered/read/replied — recibos da Meta e o flag de reply mudam o
 *   status antes deste ponto) e sent_at dentro da janela.
 * - Só atribui conversa SEM responsável: o UPDATE carrega
 *   `assigned_agent_id IS NULL` na cláusula — nunca rouba conversa de humano
 *   nem de outro perfil, e é à prova de corrida entre inbounds simultâneos.
 * - Best-effort: erro é logado e engolido (o ACK do webhook não pode falhar).
 * Deve rodar ANTES de dispatchInboundToAiAgent — o gate resolveAssignedProfile
 * (dispatch.ts) só enfileira conversa já atribuída a um perfil.
 * Service-role (RLS bypass) → filtro de account_id explícito via join.
 */
export async function assignBroadcastAgentIfAny(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<void> {
  try {
    const since = new Date(Date.now() - ASSIGN_WINDOW_MS).toISOString()
    const { data: recs, error } = await db
      .from('broadcast_recipients')
      .select('id, sent_at, broadcasts!inner(account_id, ai_profile_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .not('broadcasts.ai_profile_id', 'is', null)
      .in('status', ['sent', 'delivered', 'read', 'replied'])
      .gte('sent_at', since)
      .order('sent_at', { ascending: false })
      .limit(1)
    if (error || !recs || recs.length === 0) return

    const profileId = (
      recs[0].broadcasts as unknown as { ai_profile_id: string | null } | null
    )?.ai_profile_id
    if (!profileId) return

    // Guarda na cláusula: só assume conversa órfã (0 rows afetadas = já tem dono).
    const { error: updErr } = await db
      .from('conversations')
      .update({ assigned_agent_id: profileId })
      .eq('id', conversationId)
      .eq('account_id', accountId)
      .is('assigned_agent_id', null)
    if (updErr) console.error('[broadcast] assign agent failed:', updErr.message)
  } catch (err) {
    console.error('assignBroadcastAgentIfAny failed:', err)
  }
}
