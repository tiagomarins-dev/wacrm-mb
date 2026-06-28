-- ============================================================
-- 050_agent_report_rpcs.sql — RPCs de relatório de atendimento (Fase 1).
-- SECURITY DEFINER account-scoped (espelha 031_lead_score.sql): resolve a conta
-- por auth.uid(), valida is_account_member, e FORÇA p_agent_id ao próprio caller
-- quando ele não é admin (operador não consulta dados de outro). Não aceita
-- account_id por parâmetro.
-- #variable_conflict use_column: as colunas de saída (agent_id) colidiriam com
-- colunas internas — resolvido renomeando p/ resp_agent + a diretiva.
-- ============================================================

-- Índice p/ o pareamento (window partition by conversation_id order by created_at).
create index if not exists idx_messages_conv_created on messages(conversation_id, created_at);

-- Tempo de resposta humano (FRT/ART), clipado ao horário de atendimento.
-- Pareia cliente→1ª resposta 'agent' (IGNORA 'bot'); cap 4h; FRT nulo≠0.
-- ⚠️ pareamento espelha src/lib/reports/response-time.ts (pairTurns).
create or replace function agent_response_time(
  p_window_days int default 30,
  p_connection_id uuid default null,
  p_agent_id uuid default null
) returns table(
  agent_id uuid, frt_median numeric, frt_avg numeric,
  art_median numeric, art_avg numeric, samples int
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc) then return; end if;
  -- operador só enxerga o próprio: ignora p_agent_id vindo do front
  if not is_account_member(acc, 'admin') then p_agent_id := auth.uid(); end if;

  return query
  with msgs as (   -- mensagens da conta na janela (bot fora do pareamento)
    select m.conversation_id, m.sender_type, m.sender_id, m.assigned_agent_id,
           m.created_at, m.id, c.connection_id
    from messages m
    join conversations c on c.id = m.conversation_id
    where c.account_id = acc
      and (p_connection_id is null or c.connection_id = p_connection_id)
      and m.created_at >= now() - make_interval(days => p_window_days)
      and m.sender_type in ('customer', 'agent')
  ),
  ranked as (   -- ag_before = nº de respostas 'agent' antes desta msg (na conversa)
    select r.*,
      coalesce(sum(case when r.sender_type = 'agent' then 1 else 0 end) over (
        partition by r.conversation_id order by r.created_at, r.id
        rows between unbounded preceding and 1 preceding), 0) as ag_before
    from msgs r
  ),
  cust_blocks as (   -- 1ª msg do cliente de cada bloco (mesmo ag_before = sem resposta no meio)
    select conversation_id, connection_id, ag_before as g, min(created_at) as cust_at
    from ranked where sender_type = 'customer'
    group by conversation_id, connection_id, ag_before
  ),
  agent_ans as (   -- a resposta 'agent' que fecha cada bloco g
    select conversation_id, ag_before as g, created_at as resp_at,
           coalesce(sender_id, assigned_agent_id) as responder
    from ranked where sender_type = 'agent'
  ),
  turns as (
    select cb.conversation_id, cb.connection_id, cb.cust_at, aa.resp_at, aa.responder
    from cust_blocks cb
    join agent_ans aa on aa.conversation_id = cb.conversation_id and aa.g = cb.g
  ),
  scored as (
    select t.responder as resp_agent,
           (row_number() over (partition by t.conversation_id order by t.cust_at) = 1) as is_first,
           least(
             business_seconds_between(t.cust_at, t.resp_at,
               coalesce(bh.schedule, '[]'::jsonb),
               coalesce(bh.timezone, 'America/Sao_Paulo')) / 60.0,
             240) as minutes   -- cap 4h
    from turns t
    left join business_hours bh
      on bh.account_id = acc and bh.connection_id = t.connection_id
  )
  -- percentile_cont retorna double precision → cast p/ numeric (RETURNS TABLE).
  select s.resp_agent,
         (percentile_cont(0.5) within group (order by s.minutes) filter (where s.is_first))::numeric,
         (avg(s.minutes) filter (where s.is_first))::numeric,
         (percentile_cont(0.5) within group (order by s.minutes))::numeric,
         (avg(s.minutes))::numeric,
         count(*)::int
  from scored s
  where s.resp_agent is not null
    and (p_agent_id is null or s.resp_agent = p_agent_id)
  group by s.resp_agent;
end;
$$;

-- Volume por atendente: conversas atendidas, msgs enviadas, transferências feitas,
-- handoffs recebidos da IA.
create or replace function agent_volume(
  p_window_days int default 30,
  p_connection_id uuid default null,
  p_agent_id uuid default null
) returns table(
  agent_id uuid, conversas_atendidas int, msgs_enviadas int,
  transferencias int, handoffs_ia int
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc) then return; end if;
  if not is_account_member(acc, 'admin') then p_agent_id := auth.uid(); end if;

  return query
  with am as (   -- msgs humanas (agent) na janela, por conexão
    select coalesce(m.sender_id, m.assigned_agent_id) as resp_agent, m.conversation_id
    from messages m
    join conversations c on c.id = m.conversation_id
    where c.account_id = acc
      and (p_connection_id is null or c.connection_id = p_connection_id)
      and m.created_at >= now() - make_interval(days => p_window_days)
      and m.sender_type = 'agent'
  ),
  vol as (
    select resp_agent,
           count(distinct conversation_id)::int as conversas,
           count(*)::int as msgs
    from am where resp_agent is not null group by resp_agent
  ),
  conv_scope as (   -- conversas no escopo de conexão (p/ filtrar eventos)
    select id from conversations
    where account_id = acc and (p_connection_id is null or connection_id = p_connection_id)
  ),
  tr as (   -- transferências feitas pelo atendente (actor)
    select actor_user_id as resp_agent, count(*)::int as n
    from conversation_events
    where account_id = acc and type = 'transferred' and actor_user_id is not null
      and created_at >= now() - make_interval(days => p_window_days)
      and conversation_id in (select id from conv_scope)
    group by actor_user_id
  ),
  ho as (   -- handoffs recebidos da IA (from = bot/perfil de IA, to = atendente)
    select to_agent_id as resp_agent, count(*)::int as n
    from conversation_events
    where account_id = acc and to_agent_id is not null
      and created_at >= now() - make_interval(days => p_window_days)
      and conversation_id in (select id from conv_scope)
      and (from_agent_id = '00000000-0000-0000-0000-0000000000a1'
           or from_agent_id in (select id from ai_profiles where account_id = acc))
    group by to_agent_id
  )
  select v.resp_agent, v.conversas, v.msgs,
         coalesce(tr.n, 0), coalesce(ho.n, 0)
  from vol v
  left join tr on tr.resp_agent = v.resp_agent
  left join ho on ho.resp_agent = v.resp_agent
  where p_agent_id is null or v.resp_agent = p_agent_id;
end;
$$;

grant execute on function agent_response_time(int, uuid, uuid) to authenticated;
grant execute on function agent_volume(int, uuid, uuid) to authenticated;
revoke execute on function agent_response_time(int, uuid, uuid) from anon;
revoke execute on function agent_volume(int, uuid, uuid) from anon;
