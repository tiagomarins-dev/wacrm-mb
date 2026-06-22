-- ============================================================
-- 034 — Expand/contract: connection_id NULLABLE durante o rollout.
--
-- A 033 já marcou connection_id NOT NULL nas tabelas operacionais, mas
-- a implementação do threading (cada caminho de INSERT passar a setar
-- connection_id) é feita em estágios. Enquanto isso, manter NOT NULL
-- quebraria inserts ainda não-threados. Esta migration relaxa o NOT
-- NULL; uma migration FINAL o re-aplica depois que todos os inserts
-- (webhook, contact-form, CSV, flows, broadcasts, automations) setarem
-- connection_id. Idempotente.
-- ============================================================
ALTER TABLE contacts            ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE conversations       ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE flows               ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE flow_runs           ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE broadcasts          ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE automations         ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE message_templates   ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE conversation_shares ALTER COLUMN connection_id DROP NOT NULL;
