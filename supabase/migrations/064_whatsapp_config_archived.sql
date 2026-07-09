-- 064_whatsapp_config_archived.sql
-- Esconder uma conexão da UI sem apagar (arquivar) — ex.: instância Evolution
-- morta/duplicada que ainda tem contatos vinculados (FK impede o delete).
-- NULL = ativa (comportamento atual); timestamp = arquivada (some das listas
-- de conexão da UI). Resolução de outbound/webhook segue por id/phone_number_id,
-- então conexões arquivadas não quebram dados existentes.
-- Idempotente.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;
