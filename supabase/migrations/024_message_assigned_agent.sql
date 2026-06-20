-- ============================================================
-- 024_message_assigned_agent.sql — snapshot do responsável na mensagem
--
-- Grava em cada mensagem (recebida/enviada/bot) quem era o dono do
-- atendimento (conversations.assigned_agent_id) NO INSTANTE da mensagem.
-- Diferente de sender_id (quem enviou): assigned_agent_id é o dono da
-- conversa no momento, preservado mesmo que a conversa seja reatribuída
-- depois.
--
-- Preenchido por trigger BEFORE INSERT — cobre todos os caminhos de
-- insert (send, webhook, flows, automations) sem mexer no código. O app
-- ainda pode sobrescrever passando o valor explicitamente (o trigger só
-- preenche quando vem NULL).
--
-- Idempotente — safe to run multiple times.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS assigned_agent_id UUID;

CREATE INDEX IF NOT EXISTS idx_messages_assigned_agent
  ON messages(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;

-- Copia o responsável atual da conversa para a mensagem no insert.
CREATE OR REPLACE FUNCTION public.snapshot_message_assignee()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.assigned_agent_id IS NULL THEN
    SELECT assigned_agent_id INTO NEW.assigned_agent_id
    FROM conversations
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_message_assignee ON messages;
CREATE TRIGGER set_message_assignee
  BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.snapshot_message_assignee();
