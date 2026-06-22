-- ============================================================
-- 036 — Limpeza dos registros NULL (artefatos do código antigo durante o
-- rollout) + reativação do NOT NULL em connection_id (fase contract).
--
-- Substitui a 035 (que falhava: backfillar contatos NULL duplicados para a
-- primária violava o índice único (account_id, connection_id, phone_normalized)).
-- Aqui os contatos NULL que duplicam um contato da primária são MESCLADOS
-- (conversas re-apontadas, preservando mensagens; o dup é deletado), e os
-- demais são backfillados. Idempotente. Autorizada pelo usuário.
-- ============================================================

-- 1) MESCLA: contatos NULL com o MESMO telefone de um contato já existente na
--    conexão primária da conta. Re-aponta as conversas do dup para o contato
--    mantido (e carimba a conexão), depois deleta o dup. Mensagens ficam (são
--    ligadas à conversa via conversation_id, não ao contato).
UPDATE conversations conv
SET contact_id = keep.id, connection_id = prim.id
FROM contacts dup
JOIN whatsapp_config prim ON prim.is_primary
JOIN contacts keep ON keep.account_id = dup.account_id
                  AND keep.connection_id = prim.id
                  AND keep.phone_normalized = dup.phone_normalized
WHERE conv.contact_id = dup.id
  AND dup.connection_id IS NULL
  AND keep.id <> dup.id;

DELETE FROM contacts dup
USING whatsapp_config prim, contacts keep
WHERE dup.connection_id IS NULL
  AND prim.is_primary
  AND keep.account_id = dup.account_id
  AND keep.connection_id = prim.id
  AND keep.phone_normalized = dup.phone_normalized
  AND keep.id <> dup.id;

-- 2) Contatos NULL restantes (sem duplicata na primária) → conexão primária.
UPDATE contacts c SET connection_id = prim.id
FROM whatsapp_config prim
WHERE prim.is_primary AND prim.account_id = c.account_id
  AND c.connection_id IS NULL;

-- 3) Backfill defensivo das demais tabelas operacionais → primária.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversations','flows','flow_runs','broadcasts','automations'
  ] LOOP
    EXECUTE format(
      'UPDATE %I tbl SET connection_id = wc.id
         FROM whatsapp_config wc
        WHERE wc.is_primary AND wc.account_id = tbl.account_id
          AND tbl.connection_id IS NULL', t);
  END LOOP;
END $$;

-- 4) Re-aplica NOT NULL nas 6 tabelas com todos os inserts threados.
ALTER TABLE contacts      ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE flows         ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE flow_runs     ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE broadcasts    ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE automations   ALTER COLUMN connection_id SET NOT NULL;
