-- ============================================================
-- 056 — Provider por conexão (meta | evolution) + colunas Evolution.
-- Habilita o discriminador p/ o MessageProvider. Relaxa phone_number_id
-- (hoje NOT NULL) p/ Evolution não ter número; troca o UNIQUE global de
-- phone_number_id por índices únicos PARCIAIS por provider. access_token
-- continua NOT NULL (Evolution grava placeholder). waba_id já é nullable.
-- RLS inalterada (account-scoped). Idempotente: IF EXISTS / IF NOT EXISTS.
-- ============================================================

-- (1) provider com default 'meta' → toda linha existente nasce meta.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'meta'
  CHECK (provider IN ('meta','evolution'));

-- (2) colunas Evolution (instância + base url opcional por-conexão).
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS instance_name TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS evolution_base_url TEXT;

-- (3) relax: phone_number_id hoje é NOT NULL (Evolution não tem número).
ALTER TABLE whatsapp_config ALTER COLUMN phone_number_id DROP NOT NULL;
-- (waba_id já é nullable; access_token segue NOT NULL — placeholder p/ Evolution.)

-- (4) troca o UNIQUE global por índices únicos PARCIAIS por provider.
--     É uma CONSTRAINT (não índice avulso) → DROP CONSTRAINT (derruba o índice backing).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_phone_number_id_key;
-- Meta: phone único entre conexões meta (o webhook resolve por phone_number_id).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wc_meta_phone
  ON whatsapp_config (phone_number_id)
  WHERE provider = 'meta' AND phone_number_id IS NOT NULL;
-- Evolution: instância única por conta.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wc_evolution_instance
  ON whatsapp_config (account_id, instance_name)
  WHERE provider = 'evolution' AND instance_name IS NOT NULL;
