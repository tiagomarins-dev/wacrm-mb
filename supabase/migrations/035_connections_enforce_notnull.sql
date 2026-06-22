-- ============================================================
-- 035 — Fase CONTRACT do expand/contract (multi-número, 033/034).
--
-- Re-aplica NOT NULL em connection_id nas tabelas operacionais cujos
-- TODOS os caminhos de INSERT já carimbam a conexão (webhook, contact
-- form, CSV, flows POST + startNewRun, broadcasts create, automations
-- POST). Deve rodar SÓ NO DEPLOY do código que faz o threading — se
-- aplicada com o app antigo no ar, inserts sem connection_id falhariam.
--
-- Backfill defensivo antes do NOT NULL: qualquer linha remanescente com
-- connection_id NULL (ex.: inbound criado por código antigo durante o
-- rollout) recebe a conexão primária da conta. Idempotente.
--
-- FICAM NULLABLE (insert paths ainda não 100% threados — trabalho futuro
-- com verificação no app/Meta):
--   message_templates (submit + template-manager UI),
--   conversation_shares (share endpoint),
--   automation_logs / automation_pending_executions / link_clicks
--   (secundárias/analytics; já nullable desde a 034).
-- ============================================================

-- Backfill defensivo → conexão primária da conta.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contacts','conversations','flows','flow_runs','broadcasts','automations'
  ] LOOP
    EXECUTE format(
      'UPDATE %I tbl SET connection_id = wc.id
         FROM whatsapp_config wc
        WHERE wc.account_id = tbl.account_id AND wc.is_primary
          AND tbl.connection_id IS NULL', t);
  END LOOP;
END $$;

-- Re-aplica NOT NULL.
ALTER TABLE contacts      ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE flows         ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE flow_runs     ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE broadcasts    ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE automations   ALTER COLUMN connection_id SET NOT NULL;
