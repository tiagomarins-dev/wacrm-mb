-- ============================================================
-- 025_broadcast_schedule_index.sql — índices p/ o cron de broadcast
--
-- Agendamento de broadcast: o cron seleciona broadcasts agendadas
-- vencidas (status='scheduled' AND scheduled_at<=now) e retoma as que
-- ficaram 'sending' com recipients ainda pendentes. Índices parciais
-- mantêm essas varreduras baratas. O drain por broadcast já é coberto
-- por idx_broadcast_recipients_broadcast_status (migration 003).
--
-- Sem coluna/status novo — scheduled_at e o status 'scheduled' já
-- existem desde a 001. Idempotente — safe to run multiple times.
-- ============================================================

-- Seleção das agendadas vencidas (cron, a cada tick).
CREATE INDEX IF NOT EXISTS idx_broadcasts_due_scheduled
  ON broadcasts(scheduled_at) WHERE status = 'scheduled';

-- Retomada de broadcasts que ficaram 'sending' entre ticks.
CREATE INDEX IF NOT EXISTS idx_broadcasts_sending
  ON broadcasts(updated_at) WHERE status = 'sending';
