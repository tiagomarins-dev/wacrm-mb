-- ============================================================
-- 076_conversation_favorites.sql — favorito de conversa POR USUÁRIO
--
-- Pina a conversa na aba "Minhas" de quem favoritou, mesmo desatribuída
-- (RPC 045 segue soltando normalmente — favorito é visibilidade, não
-- reserva), atribuída a outro, ou finalizada. N usuários podem favoritar
-- a mesma conversa (UNIQUE por par user×conversation).
-- RLS per-user (espelha 028): cada um só lê/insere/apaga os próprios;
-- WITH CHECK do INSERT valida que a conversa pertence à conta informada.
-- Fora da publication realtime de propósito — ação do próprio usuário.
-- Idempotente — seguro rodar múltiplas vezes.
-- ============================================================

CREATE TABLE IF NOT EXISTS conversation_favorites (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Alvo do onConflict do upsert; cobre índice por user (prefixo)
  CONSTRAINT uq_conversation_favorites UNIQUE (user_id, conversation_id)
);

-- Caminho do CASCADE ao deletar conversa (espelha idx_conversation_shares_conv)
CREATE INDEX IF NOT EXISTS idx_conversation_favorites_conv
  ON conversation_favorites(conversation_id);

ALTER TABLE conversation_favorites ENABLE ROW LEVEL SECURITY;

-- SELECT mais restrito que a 028 de propósito: favorito é privado do usuário.
DROP POLICY IF EXISTS conversation_favorites_select ON conversation_favorites;
CREATE POLICY conversation_favorites_select ON conversation_favorites FOR SELECT
  USING (is_account_member(account_id) AND user_id = auth.uid());

-- INSERT valida o vínculo conversa↔conta (defense-in-depth).
DROP POLICY IF EXISTS conversation_favorites_insert ON conversation_favorites;
CREATE POLICY conversation_favorites_insert ON conversation_favorites FOR INSERT
  WITH CHECK (
    is_account_member(account_id, 'agent')
    AND user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM conversations c
      WHERE c.id = conversation_favorites.conversation_id
        AND c.account_id = conversation_favorites.account_id
    )
  );

DROP POLICY IF EXISTS conversation_favorites_delete ON conversation_favorites;
CREATE POLICY conversation_favorites_delete ON conversation_favorites FOR DELETE
  USING (is_account_member(account_id, 'agent') AND user_id = auth.uid());
