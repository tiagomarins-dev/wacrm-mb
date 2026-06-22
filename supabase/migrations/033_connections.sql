-- ============================================================
-- 033 — Multi-número por conexões (connection-scoped).
-- whatsapp_config vira 1:N por conta; o dado operacional ganha
-- connection_id (= whatsapp_config.id). Os índices de unicidade hoje
-- account-scoped passam a connection-scoped. RLS continua por conta
-- (is_account_member). Idempotente: IF EXISTS / IF NOT EXISTS.
-- Ordem interna obrigatória: (0) config 1:N → (a) colunas →
-- (b) backfill → (c) guard + reconstruir unicidade → (d) NOT NULL + índices.
-- ============================================================

-- (0) whatsapp_config 1:N -------------------------------------
-- Dropar UNIQUE(account_id) (era 017). Manter UNIQUE(phone_number_id) (013).
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT false;
-- Garante no máximo 1 conexão primária por conta (envio default / fallback do seletor).
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_config_one_primary
  ON whatsapp_config(account_id) WHERE is_primary;

-- (a) connection_id nas 11 tabelas operacionais ---------------
-- FK ON DELETE RESTRICT: conexão com dado não pode ser hard-deletada;
-- "remover conexão" é soft (status='disconnected') no app.
ALTER TABLE contacts                       ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE conversations                  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE flows                          ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE flow_runs                      ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE broadcasts                     ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE automations                    ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE automation_logs                ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE automation_pending_executions  ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE message_templates              ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE conversation_shares            ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;
ALTER TABLE link_clicks                    ADD COLUMN IF NOT EXISTS connection_id UUID REFERENCES whatsapp_config(id) ON DELETE RESTRICT;

-- (b) backfill ------------------------------------------------
-- Hoje há no máx. 1 config por conta (UNIQUE account_id pré-033) → marcá-la primária.
UPDATE whatsapp_config SET is_primary = true WHERE is_primary = false;
-- Atribui connection_id = config existente da conta em todas as tabelas.
-- (Todas têm account_id pós-017; conversation_shares=028, link_clicks=029.)
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contacts','conversations','flows','flow_runs','broadcasts','automations',
    'automation_logs','automation_pending_executions','message_templates',
    'conversation_shares','link_clicks'
  ] LOOP
    EXECUTE format(
      'UPDATE %I tbl SET connection_id = wc.id
         FROM whatsapp_config wc
        WHERE wc.account_id = tbl.account_id AND tbl.connection_id IS NULL', t);
  END LOOP;
END $$;

-- (c) guard de duplicatas + reconstruir unicidade connection-scoped ---
-- Templates: guard no padrão da 014 (falha alto; o operador decide qual manter).
DO $$
DECLARE dupe_count INT;
BEGIN
  SELECT count(*) INTO dupe_count FROM (
    SELECT connection_id, name, language FROM message_templates
    GROUP BY connection_id, name, language HAVING count(*) > 1
  ) d;
  IF dupe_count > 0 THEN
    RAISE EXCEPTION 'Cannot add UNIQUE(connection_id,name,language) on message_templates: % duplicate combination(s). Resolva e re-rode.', dupe_count;
  END IF;
END $$;

-- Templates: o nome real do índice antigo é message_templates_user_name_language_key (014).
DROP INDEX IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_connection_name_language_key
  ON message_templates (connection_id, name, language);

-- Contacts: dedup por número agora é por conexão (era account-scoped, 022).
DROP INDEX IF EXISTS idx_contacts_account_phone_normalized;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_connection_phone_normalized
  ON contacts (account_id, connection_id, phone_normalized) WHERE phone_normalized <> '';

-- Flow runs: "um run ativo por contato" agora é por conexão (era account-scoped, 017).
DROP INDEX IF EXISTS idx_one_active_run_per_contact;
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run_per_contact
  ON flow_runs(account_id, connection_id, contact_id) WHERE status = 'active';

-- (d) NOT NULL (pós-backfill) + índices de hot lookup ---------
ALTER TABLE contacts            ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE conversations       ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE flows               ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE flow_runs           ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE broadcasts          ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE automations         ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE message_templates   ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE conversation_shares ALTER COLUMN connection_id SET NOT NULL;
-- automation_logs / automation_pending_executions / link_clicks: NULLABLE
-- (linhas históricas/manual podem não ter conexão associada).

CREATE INDEX IF NOT EXISTS idx_conversations_connection ON conversations(connection_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contacts_connection      ON contacts(connection_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_connection     ON flow_runs(connection_id);
