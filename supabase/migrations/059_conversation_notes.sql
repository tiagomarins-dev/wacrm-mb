-- ============================================================
-- Notas internas por CONVERSA (post-it no fluxo do inbox). Só a equipe vê;
-- NUNCA vai ao cliente — não entra em `messages` nem no pipeline de envio,
-- e o histórico do LLM (ai-agent) lê só `messages`, então ignora a nota.
-- RLS espelha contact_notes (017); realtime espelha conversation_events (048).
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_notes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_notes_conv
  ON conversation_notes(conversation_id, created_at);

ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro da conta. Escrita: agent+ (espelha contact_notes 017:356-360).
DROP POLICY IF EXISTS conversation_notes_select ON conversation_notes;
CREATE POLICY conversation_notes_select ON conversation_notes FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS conversation_notes_insert ON conversation_notes;
CREATE POLICY conversation_notes_insert ON conversation_notes FOR INSERT WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS conversation_notes_update ON conversation_notes;
CREATE POLICY conversation_notes_update ON conversation_notes FOR UPDATE USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS conversation_notes_delete ON conversation_notes;
CREATE POLICY conversation_notes_delete ON conversation_notes FOR DELETE USING (is_account_member(account_id, 'agent'));

-- Realtime: publica p/ os INSERTs chegarem na thread (idêntico ao 048:54-62).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'conversation_notes'
  ) then
    alter publication supabase_realtime add table conversation_notes;
  end if;
end $$;
