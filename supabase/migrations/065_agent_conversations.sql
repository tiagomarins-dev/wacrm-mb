-- 065_agent_conversations.sql
-- Conversas que "passaram por" um atendente num período (owner-only): união de
-- atribuídas (conversation_events.to_agent_id, 048) e respondidas por ele
-- (messages sender_type='agent'). SECURITY DEFINER, escopo à conta do caller.
-- Owner apenas (accounts.owner_user_id) — agent/admin recebem vazio.
-- Fuso do "dia": o range [p_from, p_to) vem do front no fuso do browser (aceito no MVP).
create or replace function agent_conversations(
  p_agent_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_connection_id uuid default null
) returns table(
  conversation_id uuid, contact_id uuid, contact_name text, contact_phone text,
  last_message_text text, last_message_at timestamptz, status text, assigned_agent_id uuid
) language plpgsql stable security definer set search_path = public as $$
-- Colunas OUT (conversation_id/status/...) colidem com colunas dos CTEs/conversations;
-- use_column resolve pro nome da coluna (espelha agent_volume, 050).
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null then return; end if;
  -- OWNER apenas (denormalizado em accounts.owner_user_id, 017). Agent/admin → vazio.
  if not exists (select 1 from accounts a where a.id = acc and a.owner_user_id = auth.uid()) then
    return;
  end if;

  return query
  with handled as (
    -- atribuídas a ele no período (audit de atribuição, 048)
    select e.conversation_id
    from conversation_events e
    where e.account_id = acc
      and e.to_agent_id = p_agent_id
      and e.created_at >= p_from and e.created_at < p_to
    union
    -- respondidas por ele no período. sender_type='agent' (igual agent_volume) —
    -- senão inbound do cliente / msg do bot com assigned=p_agent entrariam.
    select m.conversation_id
    from messages m
    join conversations c2 on c2.id = m.conversation_id
    where c2.account_id = acc
      and m.sender_type = 'agent'
      and coalesce(m.sender_id, m.assigned_agent_id) = p_agent_id
      and m.created_at >= p_from and m.created_at < p_to
  )
  select c.id, c.contact_id, ct.name, ct.phone,
         c.last_message_text, c.last_message_at, c.status, c.assigned_agent_id
  from (select distinct conversation_id from handled) h
  join conversations c on c.id = h.conversation_id
  left join contacts ct on ct.id = c.contact_id
  where (p_connection_id is null or c.connection_id = p_connection_id)
  order by c.last_message_at desc nulls last
  limit 500;  -- teto defensivo (um dia é pequeno)
end $$;

grant execute on function agent_conversations(uuid, timestamptz, timestamptz, uuid) to authenticated;
revoke execute on function agent_conversations(uuid, timestamptz, timestamptz, uuid) from anon;
