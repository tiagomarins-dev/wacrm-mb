-- ============================================================
-- Transcrição automática de áudio.
-- Guarda o texto transcrito/formatado + o estado da fila de
-- transcrição direto em `messages` (sem tabela nova — a própria
-- linha é a fila que o cron drena). `transcription_status`:
--   pending  -> enfileirado (insert marcou)
--   running  -> claim ativo (gatilho ou cron processando)
--   done     -> transcrito com conteúdo
--   empty    -> áudio sem fala compreensível ("Áudio sem conteúdo")
--   failed   -> erro/expirado; cron retenta enquanto attempts < MAX
-- ATENÇÃO: coluna NOVA, separada de `messages.status` (entrega).
-- Nunca gravar 'running' em messages.status (CHECK só aceita
-- sending|sent|delivered|read|failed).
-- ============================================================
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_status TEXT
  CHECK (transcription_status IN ('pending','running','done','empty','failed'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_attempts INT NOT NULL DEFAULT 0;

-- Índice parcial: o cron só varre o que falta transcrever.
CREATE INDEX IF NOT EXISTS idx_messages_transcription_todo
  ON messages(transcription_status, created_at)
  WHERE transcription_status IN ('pending','failed');

-- Config por conta (campos NÃO-secretos -> plaintext, sem encrypt).
-- Defaults dos modelos ficam no código (src/lib/transcription/constants.ts);
-- estas colunas só guardam override por conta.
ALTER TABLE integrations_config ADD COLUMN IF NOT EXISTS transcription_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE integrations_config ADD COLUMN IF NOT EXISTS transcription_model TEXT;
ALTER TABLE integrations_config ADD COLUMN IF NOT EXISTS transcription_fallback_model TEXT;
ALTER TABLE integrations_config ADD COLUMN IF NOT EXISTS transcription_format_model TEXT;
