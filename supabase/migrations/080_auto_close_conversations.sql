-- ============================================================
-- 080_auto_close_conversations.sql — fechar conversa parada (auto-close).
-- Coluna de config por conexao + indice do sweep + funcao batched.
-- Conversa aberta cuja ULTIMA MENSAGEM passou do limite da conexao vira
-- 'closed'. Irma do auto-unassign (045): la solta o responsavel, aqui encerra.
-- Idempotente.
-- ============================================================

-- Dias sem mensagem p/ fechar. 0 = desligado. Default 30.
ALTER TABLE ai_agent_config
  ADD COLUMN IF NOT EXISTS auto_close_days INTEGER NOT NULL DEFAULT 30;

-- Indice do sweep: so os dois status de sistema que fecham, por last_message_at
-- (evita seqscan a cada tick do cron).
CREATE INDEX IF NOT EXISTS idx_conversations_open_idle
  ON conversations (last_message_at)
  WHERE status IN ('open', 'pending');

-- Fecha conversas paradas alem do limite da conexao.
-- Relogio = last_message_at (COALESCE created_at cobre conversa sem mensagem):
-- so mensagem adia o fechamento; nota, tag ou atribuicao nao.
-- Escapam: favoritada por alguem (vigiada de proposito) e status customizado da
-- conta (so 'open'/'pending' fecham — as custom sao regra de negocio do cliente).
-- COALESCE 30 cobre conexoes sem row de config; 0 desliga.
-- Teto de 200 por chamada: a primeira rodada tem backlog de anos e um UPDATE
-- unico dispararia realtime pra todo inbox de uma vez; o cron de 60s drena o
-- resto nos ticks seguintes. ORDER BY = mais antigas primeiro (drenagem estavel).
-- Rodada por service-role no cron — sem SECURITY DEFINER; SET search_path por
-- higiene. updated_at e o evento 'status_changed' saem dos triggers da tabela.
CREATE OR REPLACE FUNCTION public.close_inactive_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE v_count INTEGER;
BEGIN
  WITH due AS (
    SELECT c.id
      FROM conversations c
      JOIN whatsapp_config wc ON wc.id = c.connection_id
      LEFT JOIN ai_agent_config cfg ON cfg.connection_id = wc.id
     WHERE c.status IN ('open', 'pending')
       AND COALESCE(cfg.auto_close_days, 30) > 0
       AND COALESCE(c.last_message_at, c.created_at)
             < now() - (COALESCE(cfg.auto_close_days, 30) || ' days')::interval
       AND NOT EXISTS (
             SELECT 1 FROM conversation_favorites f WHERE f.conversation_id = c.id
           )
     ORDER BY COALESCE(c.last_message_at, c.created_at)
     LIMIT 200
  ), closed AS (
    UPDATE conversations c
       SET status = 'closed'
      FROM due
     WHERE c.id = due.id
    RETURNING c.id
  )
  SELECT count(*) INTO v_count FROM closed;
  RETURN v_count;
END; $$;
