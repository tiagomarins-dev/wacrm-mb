-- ============================================================
-- 045_auto_unassign.sql — desatribuir conversa ociosa (volta pra Fila).
-- Coluna de config por conexao + indice do sweep + funcao batched.
-- Conversa atribuida e parada (updated_at) alem do limite da conexao perde
-- o responsavel (assigned_agent_id=NULL) e volta pra Fila. Nao fecha.
-- Idempotente.
-- ============================================================

-- Limite de inatividade por conexao (min). 0 = desligado. Default 60.
ALTER TABLE ai_agent_config
  ADD COLUMN IF NOT EXISTS auto_unassign_minutes INTEGER NOT NULL DEFAULT 60;

-- Indice do sweep: so atribuidas e nao-fechadas, por updated_at (evita seqscan
-- a cada tick do cron).
CREATE INDEX IF NOT EXISTS idx_conversations_assigned_idle
  ON conversations (updated_at)
  WHERE assigned_agent_id IS NOT NULL AND status <> 'closed';

-- Desatribui conversas atribuidas e paradas alem do limite da conexao.
-- COALESCE 60 cobre conexoes sem row de config; 0 desliga. Humano E bot
-- (sem filtro de AI_AGENT_USER_ID). Rodada por service-role no cron — sem
-- SECURITY DEFINER; SET search_path por higiene.
CREATE OR REPLACE FUNCTION public.unassign_inactive_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_count INTEGER;
BEGIN
  WITH released AS (
    UPDATE conversations c
       SET assigned_agent_id = NULL
      FROM whatsapp_config wc
      LEFT JOIN ai_agent_config cfg ON cfg.connection_id = wc.id
     WHERE c.connection_id = wc.id
       AND c.assigned_agent_id IS NOT NULL
       AND c.status <> 'closed'
       AND COALESCE(cfg.auto_unassign_minutes, 60) > 0
       AND c.updated_at < now() - (COALESCE(cfg.auto_unassign_minutes, 60) || ' minutes')::interval
    RETURNING c.id
  )
  SELECT count(*) INTO v_count FROM released;
  RETURN v_count;
END; $$;
