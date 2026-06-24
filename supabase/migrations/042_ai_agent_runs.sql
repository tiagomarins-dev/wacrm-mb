-- ============================================================
-- 042_ai_agent_runs.sql — Observabilidade do agente: telemetria run-level.
--
-- 1 linha por execução do agente (custo/tokens/latência/status/erro). Imutável,
-- insert-once via service-role (cron/engine). Admin lê (painel/supervisor
-- futuros). Espelha o padrão de tabela + RLS de 037_ai_agent.sql:
--   uuid_generate_v4(), FK account_id ON DELETE CASCADE, RLS is_account_member,
--   idempotência IF NOT EXISTS. Sem trigger updated_at (run é imutável).
-- Sem policy de write: service-role bypassa RLS; cliente não escreve runs.
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_agent_runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,  -- run sobrevive ao delete da conversa (histórico de custo)
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  profile_id UUID REFERENCES ai_profiles(id) ON DELETE SET NULL,         -- perfil responsável; SET NULL preserva histórico
  inbound_message_id TEXT,          -- wamid da MENSAGEM DO CLIENTE que disparou (não a resposta do bot)
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','no_reply','blocked','error','superseded')),
  error_phase TEXT CHECK (error_phase IS NULL OR error_phase IN ('auth','llm','tool','send')),
  error_message TEXT,               -- msg curta + status; nunca body cru / Authorization
  finish_reason TEXT,
  requests INTEGER NOT NULL DEFAULT 0,   -- nº de chamadas OpenRouter
  turns INTEGER NOT NULL DEFAULT 0,      -- iterações do loop (hoje requests==turns, diverge em ≤1 no break por erro)
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd NUMERIC(12,6),
  latency_ms INTEGER,               -- total da run (engine)
  llm_ms INTEGER,                   -- soma das chamadas OpenRouter
  tools_used TEXT[],
  topic TEXT,                       -- 'vendas' | 'suporte' | null
  handoff BOOLEAN NOT NULL DEFAULT false,
  guardrail_hits INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_runs_account_created ON ai_agent_runs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_runs_conversation ON ai_agent_runs (conversation_id);
CREATE INDEX IF NOT EXISTS idx_ai_runs_failures ON ai_agent_runs (account_id, created_at DESC) WHERE status IN ('error','blocked','no_reply');
ALTER TABLE ai_agent_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_runs_read ON ai_agent_runs;
CREATE POLICY ai_agent_runs_read ON ai_agent_runs FOR SELECT
  USING (is_account_member(account_id,'admin'));
