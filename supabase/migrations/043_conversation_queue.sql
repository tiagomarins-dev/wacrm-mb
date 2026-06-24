-- ============================================================
-- 043_conversation_queue.sql — base da fila de atendimento.
--
-- Denormaliza em conversations o sender da ULTIMA mensagem
-- (last_message_sender_type), pra a UI saber, sem JOIN, se a conversa
-- esta "aguardando resposta" (ultima msg = customer). Sustenta as abas
-- Fila / SLA do inbox.
--
-- Trigger AFTER INSERT em messages (propaga NEW.sender_type -> conversa).
-- NAO e BEFORE/mutacao de NEW (esse e o padrao da 024, que aqui nao se
-- aplica). Fonte unica: cobre webhook/send/automations/flows/agente sem
-- tocar em nenhum write-point.
--
-- Idempotente — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_sender_type TEXT;

-- Propaga o sender da mensagem recem-inserida para a conversa pai.
CREATE OR REPLACE FUNCTION public.set_conversation_last_sender()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
     SET last_message_sender_type = NEW.sender_type
   WHERE id = NEW.conversation_id;
  RETURN NULL;  -- AFTER trigger: retorno e ignorado
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_conversation_last_sender ON messages;
CREATE TRIGGER set_conversation_last_sender
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.set_conversation_last_sender();

-- Indice parcial de fila: nao-atribuidas, FIFO por last_message_at.
CREATE INDEX IF NOT EXISTS idx_conversations_queue
  ON conversations (account_id, last_message_at)
  WHERE assigned_agent_id IS NULL;

-- Backfill de TODAS as contas (sem filtro de user): sender da ultima msg
-- de cada conversa. Usa idx_messages_conversation (001:177) — nao e seqscan.
UPDATE conversations c
   SET last_message_sender_type = (
     SELECT m.sender_type FROM messages m
     WHERE m.conversation_id = c.id
     ORDER BY m.created_at DESC LIMIT 1
   )
 WHERE c.last_message_sender_type IS NULL;
