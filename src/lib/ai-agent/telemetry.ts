// ============================================================
// Persiste a telemetria de UMA execução do agente em ai_agent_runs
// (observabilidade: custo/tokens/latência/status por run).
//
// Best-effort: NUNCA propaga erro — nem falha de insert, nem "relation does
// not exist" na janela de deploy (código sobe antes da migration 042). Não
// pode, em hipótese alguma, derrubar o envio da resposta ao cliente.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiAgentRun } from '@/types'

// Campos da run montados pelo engine (sem id/created_at — defaults no banco).
export type AgentRunInsert = Omit<AiAgentRun, 'id' | 'created_at'>

// Grava a run. Engole qualquer erro (só loga) para isolar a observabilidade
// do caminho crítico de atendimento.
export async function recordAgentRun(db: SupabaseClient, run: AgentRunInsert): Promise<void> {
  try {
    const { error } = await db.from('ai_agent_runs').insert(run)
    if (error) console.error('[ai_agent] recordAgentRun failed:', error.message)
  } catch (err) {
    console.error('[ai_agent] recordAgentRun threw:', err instanceof Error ? err.message : err)
  }
}
