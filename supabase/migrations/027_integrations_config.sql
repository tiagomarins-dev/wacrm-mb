-- ============================================================
-- 027_integrations_config.sql — config de integrações por conta
--
-- OpenRouter (resumo IA) + Notion + Slack, account-level, gerenciado
-- por admin. Uma linha por conta. Tokens guardados como TEXT e
-- criptografados NA APLICAÇÃO (src/lib/whatsapp/encryption.ts,
-- AES-256-GCM) antes de salvar — NÃO há criptografia no banco.
-- model/prompt/database_id/channel_id ficam em texto puro.
--
-- RLS: só admin+ lê/escreve (is_account_member(account_id,'admin')).
-- Idempotente — safe to run multiple times (padrão 001/017).
-- ============================================================

CREATE TABLE IF NOT EXISTS integrations_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- OpenRouter
  openrouter_api_key TEXT,          -- encrypted (app-side)
  openrouter_model TEXT,            -- ex: "openai/gpt-4o-mini"
  openrouter_summary_prompt TEXT,   -- prompt de sistema (admin edita)
  -- Notion
  notion_api_key TEXT,              -- encrypted
  notion_database_id TEXT,
  -- Slack
  slack_bot_token TEXT,             -- encrypted
  slack_channel_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE integrations_config ENABLE ROW LEVEL SECURITY;

-- Só admin+ da conta lê/escreve.
DROP POLICY IF EXISTS integrations_config_rw ON integrations_config;
CREATE POLICY integrations_config_rw ON integrations_config FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Trigger: nome set_updated_at, função update_updated_at_column() (001).
DROP TRIGGER IF EXISTS set_updated_at ON integrations_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON integrations_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
