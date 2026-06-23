-- ============================================================
-- 041_conversations_dedup.sql — 1 conversa por (account_id, connection_id, contact_id).
--
-- Ate aqui `conversations` so tinha indices nao-unique; o webhook fazia
-- find-then-insert nao-atomico (route.ts:963). Sob entregas concorrentes
-- do Meta para o mesmo contato, duas conversas eram criadas — e o
-- `.maybeSingle()` com >1 linha passou a ignorar o erro e criar mais a
-- cada msg. Esta migration, em ordem:
--   1. mergeia duplicatas na conversa mais antiga, re-apontando os filhos
--      ANTES de deletar (sem perda);
--   2. cria UNIQUE(account_id, connection_id, contact_id) — a garantia
--      autoritativa que cobre todo caminho de escrita.
--
-- Espelha 022_contact_phone_dedup.sql (merge SECURITY DEFINER + hardening).
-- Idempotente — re-executavel. **Sem perda de dados** (filhos re-apontados),
-- EXCETO ai_agent_pending do loser, descartada por design (fila transitoria
-- de debounce; UNIQUE(conversation_id) impede o re-point). Em falha do
-- CREATE INDEX por race concorrente, basta re-rodar a migration.
-- ============================================================

-- Merge re-rodavel das conversas duplicadas. SECURITY DEFINER para
-- re-apontar linhas entre tabelas independente do RLS do chamador; so
-- colapsa duplicatas exatas dentro do mesmo (account_id, connection_id,
-- contact_id). Espelha public.merge_duplicate_contacts() (022:38-108).
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           connection_id,
           contact_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids
    FROM conversations
    GROUP BY account_id, connection_id, contact_id
    HAVING count(*) > 1
  LOOP
    v_survivor := v_group.ids[1];                                  -- mais antiga
    v_losers   := v_group.ids[2:array_length(v_group.ids, 1)];
    v_all      := v_group.ids;

    -- Re-aponta filhos dos losers -> sobrevivente ANTES do delete.
    -- messages/message_reactions sao ON DELETE CASCADE: sem o re-point
    -- seriam apagados junto com a conversa loser.
    UPDATE messages            SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions   SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    -- deals tem FK ON DELETE NO ACTION (001:273): sem o re-point o DELETE
    -- abaixo falharia com 23503. Preserva tambem o vinculo negocio<->conversa.
    UPDATE deals               SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    -- flow_runs / conversation_shares: SET NULL e sem UNIQUE em
    -- conversation_id — re-point simples preserva o vinculo.
    UPDATE flow_runs           SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE conversation_shares SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    -- ai_agent_pending NAO e re-apontado: UNIQUE(conversation_id) (037:49)
    -- colidiria. O ON DELETE CASCADE remove a pendencia do loser no delete.

    -- Recomputa agregados do sobrevivente a partir das LINHAS de conversa
    -- do grupo: last_message_* da linha de MAX(last_message_at) (ja vem
    -- formatado pelo app — placeholder de midia '[image]' preservado, vide
    -- route.ts:631; recompor de messages.content_text regrediria midia para
    -- NULL); unread_count somado; status promovido a 'open' se qualquer
    -- linha for open (senao o filtro "open" do inbox esconderia conversa
    -- com nao lidas); assigned_agent_id preservado (senao herda o 1o
    -- nao-nulo do grupo); updated_at bumpado (higiene).
    UPDATE conversations c SET
      last_message_text = src.last_message_text,
      last_message_at   = src.last_message_at,
      unread_count      = agg.total_unread,
      status            = CASE WHEN agg.has_open THEN 'open' ELSE c.status END,
      assigned_agent_id = COALESCE(c.assigned_agent_id, agg.any_agent),
      updated_at        = NOW()
    FROM (
      SELECT
        COALESCE(SUM(unread_count), 0)                       AS total_unread,
        bool_or(status = 'open')                             AS has_open,
        (array_agg(assigned_agent_id)
           FILTER (WHERE assigned_agent_id IS NOT NULL))[1]  AS any_agent
      FROM conversations WHERE id = ANY(v_all)
    ) agg,
    LATERAL (
      SELECT last_message_text, last_message_at
      FROM conversations
      WHERE id = ANY(v_all)
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
      LIMIT 1
    ) src
    WHERE c.id = v_survivor;

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;

-- Colapsa as duplicatas existentes agora.
SELECT public.merge_duplicate_conversations();

-- Garantia autoritativa. As 3 colunas sao NOT NULL (contact_id 001:143,
-- account_id 017:259, connection_id 036:59) — sem WHERE. Serve tambem de
-- indice de lookup para o find de findOrCreateConversation (route.ts:973).
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_connection_contact
  ON conversations (account_id, connection_id, contact_id);
