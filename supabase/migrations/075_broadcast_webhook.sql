-- ============================================================
-- 075_broadcast_webhook.sql — Broadcast disparado por webhook
--
-- Modelo blueprint+clone: broadcast com status='webhook' é um MOLDE
-- (guarda template/variáveis/audience_filter + webhook_token público).
-- POST /api/broadcasts/webhook/[token] clona o molde em broadcast real
-- com audiência resolvida NA HORA; o cron drena o clone normalmente.
-- (1) webhook_token: token público bh_+32hex (texto plano de propósito —
--     a UI re-exibe a URL; revogável via regenerate). UNIQUE = índice.
-- (2) source_blueprint_id: rastreio clone→molde (SET NULL ao excluir).
-- (3) status CHECK ganha 'webhook' — CHECK não altera inline: DROP+ADD.
--     Constraint criada inline na 001 (auto-nomeada broadcasts_status_check).
-- (4) broadcast_webhook_events: dedup de X-Idempotency-Key por blueprint.
--     TTL ~24h no cron de broadcasts. Service-role only (espelha 074).
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS webhook_token TEXT UNIQUE;

ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS source_blueprint_id UUID
  REFERENCES broadcasts(id) ON DELETE SET NULL;

ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_status_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
  CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'failed', 'webhook'));

CREATE TABLE IF NOT EXISTS broadcast_webhook_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  broadcast_id UUID NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  -- CHECK espelha a validação da rota (defesa em profundidade)
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(broadcast_id, idempotency_key)
);

-- Índice pro delete do TTL no cron
CREATE INDEX IF NOT EXISTS idx_bwe_created_at
  ON broadcast_webhook_events(created_at);

ALTER TABLE broadcast_webhook_events ENABLE ROW LEVEL SECURITY;
-- Sem policy para authenticated — acesso só server-side via service-role
-- (mesmo modelo de automation_webhook_events, mig 074).
