-- ============================================================
-- 074_webhook_trigger.sql — Trigger de automação por webhook HTTP
--
-- (1) automations.webhook_token: token público (wh_ + 32 hex) que
--     identifica UMA automação na rota POST /api/automations/webhook/[token].
--     Texto plano de propósito: o builder precisa re-exibir a URL a
--     qualquer momento; revogável via regenerate. UNIQUE dá o índice
--     do lookup público.
-- (2) automation_webhook_events: dedup de X-Idempotency-Key por
--     automação. TTL de ~24h drenado pelo cron de automations.
--     Service-role only — sem policy RLS (espelha
--     automation_pending_executions, 006).
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

ALTER TABLE automations ADD COLUMN IF NOT EXISTS webhook_token TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS automation_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  -- CHECK espelha a validação da rota (defesa em profundidade)
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(automation_id, idempotency_key)
);

-- Índice pro delete do TTL no cron
CREATE INDEX IF NOT EXISTS idx_awe_created_at
  ON automation_webhook_events(created_at);

ALTER TABLE automation_webhook_events ENABLE ROW LEVEL SECURITY;
-- Sem policy para authenticated — todo acesso é server-side via
-- service-role (mesmo modelo de automation_pending_executions).
