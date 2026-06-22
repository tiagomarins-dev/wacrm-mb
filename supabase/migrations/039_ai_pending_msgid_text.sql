-- ============================================================
-- 039: corrige ai_agent_pending.last_inbound_message_id — guarda o wamid da
-- Meta (ex: "wamid.HBgN...=="), que é TEXTO, não UUID. Com UUID o INSERT do
-- dispatch falhava ("invalid input syntax for type uuid") e a conversa nunca
-- entrava na fila. Tabela vazia em prod (todos os enqueues falhavam) → cast
-- trivial. Idempotente: só altera se ainda for uuid.
-- ============================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_agent_pending'
      AND column_name = 'last_inbound_message_id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE ai_agent_pending
      ALTER COLUMN last_inbound_message_id TYPE TEXT USING last_inbound_message_id::text;
  END IF;
END $$;
