-- ============================================================
-- 057 — Inbound Evolution: idempotência de mensagem + cursor de poll.
-- (a) índice único parcial (conversation_id, message_id) p/ o poll não
--     duplicar no re-scan (hoje idx_messages_message_id é simples, 001:178).
-- (b) cursor por conexão (last_evo_timestamp) p/ buscar só o novo.
-- Idempotente. Guard de duplicatas antes do índice (padrão 033).
-- ============================================================

-- (a) dedup de duplicatas pré-existentes (race antiga do webhook que inseria
--     a mesma msg 2x antes de existir constraint). São cópias EXATAS (mesmo
--     conteúdo/timestamp) → mantém a 1ª (menor id) e remove as redundantes.
--     Espelha a dedup de contatos da 036. FK-safe (nenhuma referenciada por
--     reply_to_message_id no dump de prod). Idempotente: re-rodar não acha mais dup.
DELETE FROM messages m
USING (
  SELECT id, row_number() OVER (
    PARTITION BY conversation_id, message_id ORDER BY id
  ) AS rn
  FROM messages WHERE message_id IS NOT NULL
) ranked
WHERE m.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_msgid
  ON messages (conversation_id, message_id)
  WHERE message_id IS NOT NULL;

-- (b) cursor do poll Evolution (unix seconds da última msg importada).
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS last_evo_timestamp BIGINT;
