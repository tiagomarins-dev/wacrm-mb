-- ============================================================
-- 026_quick_replies.sql — respostas rápidas (canned responses)
--
-- Atendentes digitam `/` no composer do inbox e inserem respostas
-- prontas. Dois escopos:
--   * account  — compartilhada (admin cria/edita; todo agente usa)
--   * personal — privada do agente (dono cria/edita/vê)
--
-- RLS híbrida: SELECT devolve compartilhadas + as próprias pessoais;
-- escrita exige admin (account) OU ser o dono (personal). UPDATE com
-- USING + WITH CHECK impede um não-admin "promover" personal→account.
--
-- Idempotente — safe to run multiple times (padrão 001/017).
-- ============================================================

CREATE TABLE IF NOT EXISTS quick_replies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('account', 'personal')),
  shortcut TEXT NOT NULL,
  message_text TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT quick_replies_len CHECK (
    char_length(shortcut) <= 32 AND char_length(message_text) <= 1000
  )
);

CREATE INDEX IF NOT EXISTS idx_quick_replies_account ON quick_replies(account_id);
-- Caminho de leitura das pessoais (SELECT do menu/manager).
CREATE INDEX IF NOT EXISTS idx_quick_replies_personal
  ON quick_replies(account_id, user_id) WHERE scope = 'personal';
-- Unicidade do atalho por escopo, case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS uq_quick_replies_account_shortcut
  ON quick_replies(account_id, lower(shortcut)) WHERE scope = 'account';
CREATE UNIQUE INDEX IF NOT EXISTS uq_quick_replies_personal_shortcut
  ON quick_replies(account_id, user_id, lower(shortcut)) WHERE scope = 'personal';

ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;

-- Lê: compartilhadas da conta + as próprias pessoais.
DROP POLICY IF EXISTS quick_replies_select ON quick_replies;
CREATE POLICY quick_replies_select ON quick_replies FOR SELECT USING (
  is_account_member(account_id)
  AND (scope = 'account' OR user_id = auth.uid())
);

-- Insere: account exige admin; personal exige ser o dono.
DROP POLICY IF EXISTS quick_replies_insert ON quick_replies;
CREATE POLICY quick_replies_insert ON quick_replies FOR INSERT WITH CHECK (
  (scope = 'account' AND is_account_member(account_id, 'admin'))
  OR (scope = 'personal' AND user_id = auth.uid() AND is_account_member(account_id))
);

-- Atualiza: USING + WITH CHECK (mesmo predicado) — impede promover
-- personal→account ou reatribuir dono.
DROP POLICY IF EXISTS quick_replies_update ON quick_replies;
CREATE POLICY quick_replies_update ON quick_replies FOR UPDATE
USING (
  (scope = 'account' AND is_account_member(account_id, 'admin'))
  OR (scope = 'personal' AND user_id = auth.uid() AND is_account_member(account_id))
)
WITH CHECK (
  (scope = 'account' AND is_account_member(account_id, 'admin'))
  OR (scope = 'personal' AND user_id = auth.uid() AND is_account_member(account_id))
);

-- Deleta: mesmo predicado.
DROP POLICY IF EXISTS quick_replies_delete ON quick_replies;
CREATE POLICY quick_replies_delete ON quick_replies FOR DELETE USING (
  (scope = 'account' AND is_account_member(account_id, 'admin'))
  OR (scope = 'personal' AND user_id = auth.uid() AND is_account_member(account_id))
);

DROP TRIGGER IF EXISTS set_updated_at ON quick_replies;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON quick_replies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
