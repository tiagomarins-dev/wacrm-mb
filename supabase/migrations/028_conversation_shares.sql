-- ============================================================
-- 028_conversation_shares.sql — auditoria de compartilhamentos
--
-- Registra cada "compartilhar conversa" pro Notion/Slack: quem fez,
-- provedor, assunto, link criado, status. Account-scoped (consistente
-- com conversations pós-017): membros da conta leem; o próprio agente
-- insere/atualiza os seus.
--
-- Idempotente — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_shares (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('notion', 'slack')),
  topic TEXT,
  external_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed')),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_shares_account
  ON conversation_shares(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_shares_conv
  ON conversation_shares(conversation_id);

ALTER TABLE conversation_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_shares_select ON conversation_shares;
CREATE POLICY conversation_shares_select ON conversation_shares FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS conversation_shares_insert ON conversation_shares;
CREATE POLICY conversation_shares_insert ON conversation_shares FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent') AND user_id = auth.uid());

DROP POLICY IF EXISTS conversation_shares_update ON conversation_shares;
CREATE POLICY conversation_shares_update ON conversation_shares FOR UPDATE
  USING (is_account_member(account_id, 'agent') AND user_id = auth.uid())
  WITH CHECK (is_account_member(account_id, 'agent') AND user_id = auth.uid());
