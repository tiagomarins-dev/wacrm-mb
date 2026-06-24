-- ============================================================
-- 044_conversations_lastmsg_index.sql — indice de ordenacao da tela Conversas.
-- O idx_conversations_connection (033:95) e por created_at; a tela /conversations
-- ordena por last_message_at filtrando por connection_id. Sem este indice, cada
-- pagina faz seqscan + sort. Tela e pensada pra muito volume. Idempotente.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_conversations_conn_lastmsg
  ON conversations (connection_id, last_message_at DESC NULLS LAST);
