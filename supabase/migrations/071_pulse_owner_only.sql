-- ============================================================
-- 071: Pulso vira OWNER-only (pedido do usuário). Reaplica as 5
-- RPCs pulse_* (069/070) trocando o guard is_account_member admin
-- pelo check de owner (accounts.owner_user_id — padrão 065).
-- ============================================================

-- 4) RPC pulse_tiles — 5 métricas do topo. OWNER-only (071).
-- Semântica p_agent_id: frt/sla = RESPONDER (como 050); conversas/sem_resposta = assigned_agent_id.
-- Unidades: frt_median em MINUTOS (clipado a business hours, cap 240 — 050);
--           resolucao_median em HORAS (clock time); sla_pct em % de 1ªs respostas ≤30min.
-- sem_resposta = snapshot de AGORA (não da janela) — o front não mostra delta.
create or replace function pulse_tiles(
  p_from timestamptz,
  p_to timestamptz,
  p_agent_id uuid default null,
  p_connection_id uuid default null
) returns table(
  conversas int, frt_median numeric, sla_pct numeric,
  resolucao_median numeric, sem_resposta int
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  acc uuid;
  v_conversas int;
  v_frt numeric;
  v_sla numeric;
  v_res numeric;
  v_sem int;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null then return; end if;
  -- OWNER apenas (denormalizado em accounts.owner_user_id, 017 — padrão 065). Admin/agent → vazio.
  if not exists (select 1 from accounts a where a.id = acc and a.owner_user_id = auth.uid()) then return; end if;
  -- clamp de range: máx 400 dias (mitiga query pesada arbitrária)
  p_from := greatest(p_from, p_to - interval '400 days');

  -- conversas criadas na janela
  select count(*)::int into v_conversas
  from conversations c
  where c.account_id = acc
    and c.created_at >= p_from and c.created_at < p_to
    and (p_connection_id is null or c.connection_id = p_connection_id)
    and (p_agent_id is null or c.assigned_agent_id = p_agent_id);

  -- FRT mediana + SLA 30min — pareamento de turnos de 050, janela p_from..p_to
  with msgs as (
    select m.conversation_id, m.sender_type, m.sender_id, m.assigned_agent_id,
           m.created_at, m.id, c.connection_id
    from messages m
    join conversations c on c.id = m.conversation_id
    where c.account_id = acc
      and (p_connection_id is null or c.connection_id = p_connection_id)
      and m.created_at >= p_from and m.created_at < p_to
      and m.sender_type in ('customer', 'agent')
  ),
  ranked as (
    select r.*,
      coalesce(sum(case when r.sender_type = 'agent' then 1 else 0 end) over (
        partition by r.conversation_id order by r.created_at, r.id
        rows between unbounded preceding and 1 preceding), 0) as ag_before
    from msgs r
  ),
  cust_blocks as (
    select conversation_id, connection_id, ag_before as g, min(created_at) as cust_at
    from ranked where sender_type = 'customer'
    group by conversation_id, connection_id, ag_before
  ),
  agent_ans as (
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
             240) as minutes
    from turns t
    left join business_hours bh
      on bh.account_id = acc and bh.connection_id = t.connection_id
  )
  select (percentile_cont(0.5) within group (order by s.minutes) filter (where s.is_first))::numeric,
         (100.0 * count(*) filter (where s.is_first and s.minutes <= 30)
            / nullif(count(*) filter (where s.is_first), 0))::numeric
  into v_frt, v_sla
  from scored s
  where s.resp_agent is not null
    and (p_agent_id is null or s.resp_agent = p_agent_id);

  -- resolução mediana em HORAS: 1º evento to_status='closed' por conversa na janela, clock time
  with first_close as (
    select e.conversation_id, min(e.created_at) as closed_at
    from conversation_events e
    where e.account_id = acc and e.type = 'status_changed' and e.to_status = 'closed'
      and e.created_at >= p_from and e.created_at < p_to
    group by e.conversation_id
  )
  select (percentile_cont(0.5) within group (
           order by extract(epoch from (fc.closed_at - c.created_at)) / 3600.0))::numeric
  into v_res
  from first_close fc
  join conversations c on c.id = fc.conversation_id
  where (p_connection_id is null or c.connection_id = p_connection_id)
    and (p_agent_id is null or c.assigned_agent_id = p_agent_id);

  -- sem resposta: snapshot de agora (status system 'open')
  select count(*)::int into v_sem
  from conversations c
  where c.account_id = acc
    and c.status = 'open'
    and c.last_message_sender_type = 'customer'
    and (p_connection_id is null or c.connection_id = p_connection_id)
    and (p_agent_id is null or c.assigned_agent_id = p_agent_id);

  return query select v_conversas, v_frt, v_sla, v_res, v_sem;
end;
$$;

-- 5) RPC pulse_timeline — conversas/dia por intenção, com gap-filling (generate_series).
-- Dias no fuso America/Sao_Paulo; intent null conta como 'outro'.
create or replace function pulse_timeline(
  p_from timestamptz,
  p_to timestamptz,
  p_agent_id uuid default null,
  p_connection_id uuid default null
) returns table(dia date, vendas int, suporte int, outro int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null then return; end if;
  -- OWNER apenas (denormalizado em accounts.owner_user_id, 017 — padrão 065). Admin/agent → vazio.
  if not exists (select 1 from accounts a where a.id = acc and a.owner_user_id = auth.uid()) then return; end if;
  p_from := greatest(p_from, p_to - interval '400 days');

  return query
  select gs.dia::date,
         count(c.id) filter (where c.report_intent = 'vendas')::int,
         count(c.id) filter (where c.report_intent = 'suporte')::int,
         count(c.id) filter (where c.report_intent is null or c.report_intent not in ('vendas','suporte'))::int
  from generate_series(
         (p_from at time zone 'America/Sao_Paulo')::date,
         ((p_to - interval '1 second') at time zone 'America/Sao_Paulo')::date,
         interval '1 day') gs(dia)
  left join conversations c
    on c.account_id = acc
   and (c.created_at at time zone 'America/Sao_Paulo')::date = gs.dia::date
   and c.created_at >= p_from and c.created_at < p_to
   and (p_connection_id is null or c.connection_id = p_connection_id)
   and (p_agent_id is null or c.assigned_agent_id = p_agent_id)
  group by gs.dia
  order by gs.dia;
end;
$$;

-- 6) RPC pulse_breakdowns — jsonb {conexoes, motivos, loss, funil}.
-- Funil: leads = criadas na janela c/ intent vendas; respondidos = leads c/ ≥1 msg agent/bot até p_to;
--        fechados = attributed_sales confirmed por data_matricula (populações distintas — UI tolera fechados>respondidos).
create or replace function pulse_breakdowns(
  p_from timestamptz,
  p_to timestamptz,
  p_agent_id uuid default null,
  p_connection_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null then return null; end if;
  -- OWNER apenas (padrão 065). Admin/agent → null.
  if not exists (select 1 from accounts a where a.id = acc and a.owner_user_id = auth.uid()) then return null; end if;
  p_from := greatest(p_from, p_to - interval '400 days');

  return jsonb_build_object(
    'conexoes', (
      select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'total', x.total) order by x.total desc), '[]'::jsonb)
      from (
        select coalesce(nullif(w.label, ''), w.phone_number_id, 'Sem conexão') as name, count(*)::int as total
        from conversations c
        left join whatsapp_config w on w.id = c.connection_id
        where c.account_id = acc
          and c.created_at >= p_from and c.created_at < p_to
          and (p_connection_id is null or c.connection_id = p_connection_id)
          and (p_agent_id is null or c.assigned_agent_id = p_agent_id)
        group by 1
      ) x
    ),
    'motivos', (
      select coalesce(jsonb_agg(jsonb_build_object('key', x.k, 'total', x.total) order by x.total desc), '[]'::jsonb)
      from (
        select c.report_motivo as k, count(*)::int as total
        from conversations c
        where c.account_id = acc and c.report_intent = 'suporte' and c.report_motivo is not null
          and c.created_at >= p_from and c.created_at < p_to
          and (p_connection_id is null or c.connection_id = p_connection_id)
          and (p_agent_id is null or c.assigned_agent_id = p_agent_id)
        group by 1
      ) x
    ),
    'loss', (
      select coalesce(jsonb_agg(jsonb_build_object('key', x.k, 'total', x.total) order by x.total desc), '[]'::jsonb)
      from (
        select c.report_loss_reason as k, count(*)::int as total
        from conversations c
        where c.account_id = acc and c.report_intent = 'vendas'
          and c.report_loss_reason is not null and c.report_loss_reason <> 'nao_perdida'
          and c.created_at >= p_from and c.created_at < p_to
          and (p_connection_id is null or c.connection_id = p_connection_id)
          and (p_agent_id is null or c.assigned_agent_id = p_agent_id)
        group by 1
      ) x
    ),
    'funil', jsonb_build_object(
      'leads', (
        select count(*)::int from conversations c
        where c.account_id = acc and c.report_intent = 'vendas'
          and c.created_at >= p_from and c.created_at < p_to
          and (p_connection_id is null or c.connection_id = p_connection_id)
          and (p_agent_id is null or c.assigned_agent_id = p_agent_id)
      ),
      'respondidos', (
        select count(*)::int from conversations c
        where c.account_id = acc and c.report_intent = 'vendas'
          and c.created_at >= p_from and c.created_at < p_to
          and (p_connection_id is null or c.connection_id = p_connection_id)
          and (p_agent_id is null or c.assigned_agent_id = p_agent_id)
          and exists (
            select 1 from messages m
            where m.conversation_id = c.id
              and m.sender_type in ('agent','bot')
              and m.created_at < p_to
          )
      ),
      'fechados', (
        select count(*)::int from attributed_sales s
        where s.account_id = acc and s.status = 'confirmed'
          and s.data_matricula between (p_from at time zone 'America/Sao_Paulo')::date
                                   and ((p_to - interval '1 second') at time zone 'America/Sao_Paulo')::date
          and (p_connection_id is null or s.connection_id = p_connection_id)
          and (p_agent_id is null or s.atendente_id = p_agent_id)
      )
    )
  );
end;
$$;

-- 7) RPC pulse_radar — snapshot de AGORA (sem janela). Flags da classificação (068).
-- PII mínima: só conversation_id + contact_name (fallback phone quando sem nome), máx 3 por card.
-- oportunidades filtra intent='suporte' (flag inflada em conversas de vendas — ressalva F2).
create or replace function pulse_radar(
  p_agent_id uuid default null,
  p_connection_id uuid default null
) returns jsonb
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null then return null; end if;
  -- OWNER apenas (padrão 065). Admin/agent → null.
  if not exists (select 1 from accounts a where a.id = acc and a.owner_user_id = auth.uid()) then return null; end if;

  return (
    with base as (
      select c.id, c.report_intent, c.report_flags, c.status, c.last_message_at,
             coalesce(ct.name, ct.phone) as contact_name
      from conversations c
      left join contacts ct on ct.id = c.contact_id
      where c.account_id = acc
        and c.report_flags is not null
        and (p_connection_id is null or c.connection_id = p_connection_id)
        and (p_agent_id is null or c.assigned_agent_id = p_agent_id)
    ),
    churn as (select * from base where (report_flags->>'sentimento_negativo')::boolean is true
                and status = 'open'),
    oport as (select * from base where (report_flags->>'oportunidade_venda')::boolean is true
                and report_intent = 'suporte' and status = 'open'),
    aguard as (select * from base where (report_flags->>'aguardando_resposta')::boolean is true
                and status = 'open'),
    esfria as (select * from base where (report_flags->>'aguardando_resposta')::boolean is true
                and report_intent = 'vendas' and status = 'open'
                and last_message_at < now() - interval '3 days')
    select jsonb_build_object(
      'churn', jsonb_build_object(
        'total', (select count(*) from churn),
        'sample', (select coalesce(jsonb_agg(jsonb_build_object('conversation_id', s.id, 'contact_name', s.contact_name)), '[]'::jsonb)
                   from (select id, contact_name from churn order by last_message_at desc nulls last limit 3) s)),
      'oportunidades', jsonb_build_object(
        'total', (select count(*) from oport),
        'sample', (select coalesce(jsonb_agg(jsonb_build_object('conversation_id', s.id, 'contact_name', s.contact_name)), '[]'::jsonb)
                   from (select id, contact_name from oport order by last_message_at desc nulls last limit 3) s)),
      'aguardando', jsonb_build_object(
        'total', (select count(*) from aguard),
        'sample', (select coalesce(jsonb_agg(jsonb_build_object('conversation_id', s.id, 'contact_name', s.contact_name)), '[]'::jsonb)
                   from (select id, contact_name from aguard order by last_message_at desc nulls last limit 3) s)),
      'esfriando', jsonb_build_object(
        'total', (select count(*) from esfria),
        'sample', (select coalesce(jsonb_agg(jsonb_build_object('conversation_id', s.id, 'contact_name', s.contact_name)), '[]'::jsonb)
                   from (select id, contact_name from esfria order by last_message_at desc nulls last limit 3) s))
    )
  );
end;
$$;


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
  if acc is null then return; end if;
  -- OWNER apenas (denormalizado em accounts.owner_user_id, 017 — padrão 065). Admin/agent → vazio.
  if not exists (select 1 from accounts a where a.id = acc and a.owner_user_id = auth.uid()) then return; end if;

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


-- Grants (inalterados — o guard interno é quem nega)
grant execute on function pulse_tiles(timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function pulse_timeline(timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function pulse_breakdowns(timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function pulse_radar(uuid, uuid) to authenticated;
grant execute on function pulse_ai_row(int, uuid) to authenticated;
revoke execute on function pulse_tiles(timestamptz, timestamptz, uuid, uuid) from anon;
revoke execute on function pulse_timeline(timestamptz, timestamptz, uuid, uuid) from anon;
revoke execute on function pulse_breakdowns(timestamptz, timestamptz, uuid, uuid) from anon;
revoke execute on function pulse_radar(uuid, uuid) from anon;
revoke execute on function pulse_ai_row(int, uuid) from anon;
