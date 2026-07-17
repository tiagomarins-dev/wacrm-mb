-- ============================================================
-- 070: linha do agente de IA na tabela por atendente do Pulso.
-- As RPCs 050 só contam humanos (sender_type='agent'); a IA manda
-- como 'bot'. Esta RPC agrega o desempenho da IA na mesma janela:
--   conversas/msgs (bot), FRT/ART (pareamento cliente→bot, espelho
--   do 050 com clock time — IA não respeita business hours),
--   handoffs FEITOS p/ humano (eventos from = bot/perfil IA) e
--   vendas atribuídas sem humano (attributed_sales.atendente_id null).
-- Admin-only (molde 054).
-- ============================================================
create or replace function pulse_ai_row(
  p_window_days int default 30,
  p_connection_id uuid default null
) returns table(
  conversas_atendidas int, msgs_enviadas int,
  frt_median numeric, art_median numeric,
  handoffs int, vendas int
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  acc uuid;
  v_conversas int;
  v_msgs int;
  v_frt numeric;
  v_art numeric;
  v_handoffs int;
  v_vendas int;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc, 'admin') then return; end if;

  -- volume: mensagens do bot na janela
  select count(distinct m.conversation_id)::int, count(*)::int
  into v_conversas, v_msgs
  from messages m
  join conversations c on c.id = m.conversation_id
  where c.account_id = acc
    and (p_connection_id is null or c.connection_id = p_connection_id)
    and m.created_at >= now() - make_interval(days => p_window_days)
    and m.sender_type = 'bot';

  -- FRT/ART: pareamento cliente→bot (mesma técnica do 050, clock time — IA responde 24/7)
  with msgs as (
    select m.conversation_id, m.sender_type, m.created_at, m.id
    from messages m
    join conversations c on c.id = m.conversation_id
    where c.account_id = acc
      and (p_connection_id is null or c.connection_id = p_connection_id)
      and m.created_at >= now() - make_interval(days => p_window_days)
      and m.sender_type in ('customer', 'bot')
  ),
  ranked as (
    select r.*,
      coalesce(sum(case when r.sender_type = 'bot' then 1 else 0 end) over (
        partition by r.conversation_id order by r.created_at, r.id
        rows between unbounded preceding and 1 preceding), 0) as ag_before
    from msgs r
  ),
  cust_blocks as (
    select conversation_id, ag_before as g, min(created_at) as cust_at
    from ranked where sender_type = 'customer'
    group by conversation_id, ag_before
  ),
  bot_ans as (
    select conversation_id, ag_before as g, created_at as resp_at
    from ranked where sender_type = 'bot'
  ),
  scored as (
    select (row_number() over (partition by cb.conversation_id order by cb.cust_at) = 1) as is_first,
           least(extract(epoch from (ba.resp_at - cb.cust_at)) / 60.0, 240) as minutes
    from cust_blocks cb
    join bot_ans ba on ba.conversation_id = cb.conversation_id and ba.g = cb.g
  )
  select (percentile_cont(0.5) within group (order by s.minutes) filter (where s.is_first))::numeric,
         (percentile_cont(0.5) within group (order by s.minutes))::numeric
  into v_frt, v_art
  from scored s;

  -- handoffs feitos p/ humano (mesmo predicado do 050:140-146, invertido: contamos o FROM)
  select count(*)::int into v_handoffs
  from conversation_events e
  where e.account_id = acc and e.to_agent_id is not null
    and e.created_at >= now() - make_interval(days => p_window_days)
    and e.conversation_id in (
      select id from conversations
      where account_id = acc and (p_connection_id is null or connection_id = p_connection_id)
    )
    and (e.from_agent_id = '00000000-0000-0000-0000-0000000000a1'
         or e.from_agent_id in (select id from ai_profiles where account_id = acc));

  -- vendas sem humano no atendimento (051: atendente_id null = só IA)
  select count(*)::int into v_vendas
  from attributed_sales s
  where s.account_id = acc and s.status = 'confirmed' and s.atendente_id is null
    and s.data_matricula >= (now() - make_interval(days => p_window_days))::date
    and (p_connection_id is null or s.connection_id = p_connection_id);

  return query select v_conversas, v_msgs, v_frt, v_art, v_handoffs, v_vendas;
end;
$$;

grant execute on function pulse_ai_row(int, uuid) to authenticated;
revoke execute on function pulse_ai_row(int, uuid) from anon;
