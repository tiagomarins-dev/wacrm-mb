-- ============================================================
-- 085: distingue o fechamento por inatividade dos demais fechamentos.
-- O trigger de status (069) grava 'status_changed' com actor_user_id = auth.uid(),
-- que é NULL em tudo que roda por service-role: tanto o sweep de inatividade
-- (080) quanto o passo "Encerrar conversa" das automações. Sem uma marca própria
-- os dois ficam indistinguíveis, e o atendente não sabe por que a conversa saiu
-- da fila. O sweep passa a emitir um evento com tipo próprio.
-- Idempotente.
-- ============================================================

-- CHECK += 'closed_idle' (espelha a ampliação feita em 069:13)
alter table conversation_events drop constraint if exists conversation_events_type_check;
alter table conversation_events add constraint conversation_events_type_check
  check (type in ('assigned','transferred','unassigned','status_changed','closed_idle'));

-- Fecha conversas paradas alem do limite da conexao.
-- Relogio = last_message_at (COALESCE created_at cobre conversa sem mensagem):
-- so mensagem adia o fechamento; nota, tag ou atribuicao nao.
-- Escapam: favoritada por alguem (vigiada de proposito) e status customizado da
-- conta (so 'open'/'pending' fecham — as custom sao regra de negocio do cliente).
-- COALESCE 30 cobre conexoes sem row de config; 0 desliga.
-- Teto de 200 por chamada: a primeira rodada tem backlog de anos e um UPDATE
-- unico dispararia realtime pra todo inbox de uma vez; o cron de 60s drena o
-- resto nos ticks seguintes. ORDER BY = mais antigas primeiro (drenagem estavel).
-- Rodada por service-role no cron — sem SECURITY DEFINER; SET search_path por
-- higiene. updated_at e o evento 'status_changed' saem dos triggers da tabela;
-- o 'closed_idle' e gravado aqui porque so este caminho sabe o motivo.
create or replace function public.close_inactive_conversations()
returns integer
language plpgsql
set search_path = public
as $$
DECLARE v_count INTEGER;
BEGIN
  WITH due AS (
    SELECT c.id, c.account_id
      FROM conversations c
      JOIN whatsapp_config wc ON wc.id = c.connection_id
      LEFT JOIN ai_agent_config cfg ON cfg.connection_id = wc.id
     WHERE c.status IN ('open', 'pending')
       AND COALESCE(cfg.auto_close_days, 30) > 0
       AND COALESCE(c.last_message_at, c.created_at)
             < now() - (COALESCE(cfg.auto_close_days, 30) || ' days')::interval
       AND NOT EXISTS (
             SELECT 1 FROM conversation_favorites f WHERE f.conversation_id = c.id
           )
     ORDER BY COALESCE(c.last_message_at, c.created_at)
     LIMIT 200
  ), closed AS (
    UPDATE conversations c
       SET status = 'closed'
      FROM due
     WHERE c.id = due.id
    RETURNING c.id, c.account_id, c.status
  ), evt AS (
    INSERT INTO conversation_events
      (account_id, conversation_id, type, from_status, to_status, actor_user_id)
    SELECT account_id, id, 'closed_idle', 'open', 'closed', NULL FROM closed
  )
  SELECT count(*) INTO v_count FROM closed;
  RETURN v_count;
END; $$;
