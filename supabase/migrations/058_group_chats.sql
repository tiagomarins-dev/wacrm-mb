-- ============================================================
-- 058 — Conversas de grupo (Evolution @g.us). conversations ganha
-- chat_id/is_group; contact_id vira NULLABLE (grupo não é 1 contato).
-- A index única de dedup (041) vira PARCIAL (só 1:1) + nova index única
-- de grupo por chat_id. messages.sender_name guarda o participante
-- remetente (sem criar contato por pessoa). RLS inalterada (account-scoped).
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_id TEXT;     -- JID @g.us
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ALTER COLUMN contact_id DROP NOT NULL;     -- grupo: NULL
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name TEXT;      -- participante (grupo)

-- C2: a dedup 1:1 (041) precisa virar parcial p/ não bloquear grupos (NULL).
-- Hoje a 041 é NOT-NULL-backed (todo contact_id preenchido); drop+recreate
-- parcial é seguro (nada com contact_id NULL ainda existe).
DROP INDEX IF EXISTS idx_conversations_account_connection_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_connection_contact
  ON conversations (account_id, connection_id, contact_id)
  WHERE contact_id IS NOT NULL;

-- Dedup de grupo: 1 conversa por (conta, conexão, chat_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_connection_chatid
  ON conversations (account_id, connection_id, chat_id)
  WHERE is_group AND chat_id IS NOT NULL;
