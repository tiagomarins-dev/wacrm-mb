-- ============================================================
-- 094_member_permissions.sql — permissões por pessoa além do papel.
--
-- O papel (owner/admin/agent/viewer) continua sendo a regra geral. Duas
-- flags em profiles ajustam um membro específico sem mudar o papel dele:
--   can_manage_templates: agent que cria, edita, reenvia e exclui templates
--     (para os demais agents, template continua só de admin+).
--   hide_reports: tira do agent o relatório por atendente, inclusive a
--     métrica individual que todo agent vê. Não vale para o owner. As RPCs
--     de relatório que já são só de admin/owner (report_coverage, ai_cost_*,
--     agent_conversations, pulse_*) não olham a flag.
--
-- As flags só são confiáveis porque o cliente não grava mais colunas de
-- controle em profiles: o UPDATE de `authenticated` fica restrito a
-- full_name e avatar_url (único update que o app faz com o cliente do
-- usuário, em profile-form.tsx). Papel, conta e flags mudam só pelas RPCs
-- SECURITY DEFINER (set_member_role, redeem_invitation...) ou pelo service
-- role. Sem essa restrição, um membro gravaria account_role='owner' na
-- própria linha, e todas as policies baseadas em is_account_member cairiam.
--
-- Os corpos de agent_response_time / agent_volume / agent_sales são os de
-- produção em 27/10/2026, com uma linha a mais (reports_hidden) no topo.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

-- ------------------------------------------------------------
-- Colunas de controle de profiles: só RPC/service role gravam.
-- ------------------------------------------------------------
REVOKE UPDATE ON profiles FROM authenticated, anon;
GRANT UPDATE (full_name, avatar_url) ON profiles TO authenticated;

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS can_manage_templates BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hide_reports BOOLEAN NOT NULL DEFAULT false;

-- ------------------------------------------------------------
-- can_manage_templates: admin+ sempre; agent só com a flag.
-- Viewer nunca, mesmo com a flag ligada.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION can_manage_templates(target_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(target_account_id, 'admin')
      OR (
        is_account_member(target_account_id, 'agent')
        AND EXISTS (
          SELECT 1 FROM profiles p
          WHERE p.user_id = auth.uid()
            AND p.account_id = target_account_id
            AND p.can_manage_templates
        )
      );
$$;

ALTER FUNCTION can_manage_templates(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION can_manage_templates(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION can_manage_templates(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- reports_hidden: flag ligada e o membro não é o owner da conta.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION reports_hidden(target_account_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      AND p.hide_reports
      AND p.account_role <> 'owner'
  );
$$;

ALTER FUNCTION reports_hidden(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION reports_hidden(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reports_hidden(UUID) TO authenticated, service_role;

-- ------------------------------------------------------------
-- message_templates: leitura segue para todo membro; escrita pelo helper.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS message_templates_insert ON message_templates;
DROP POLICY IF EXISTS message_templates_update ON message_templates;
DROP POLICY IF EXISTS message_templates_delete ON message_templates;
CREATE POLICY message_templates_insert ON message_templates FOR INSERT
  WITH CHECK (can_manage_templates(account_id));
CREATE POLICY message_templates_update ON message_templates FOR UPDATE
  USING (can_manage_templates(account_id))
  WITH CHECK (can_manage_templates(account_id));
CREATE POLICY message_templates_delete ON message_templates FOR DELETE
  USING (can_manage_templates(account_id));

-- ------------------------------------------------------------
-- RPCs do relatório por atendente: vazias para quem tem hide_reports.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.agent_response_time(p_window_days integer DEFAULT 30, p_connection_id uuid DEFAULT NULL::uuid, p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(agent_id uuid, frt_median numeric, frt_avg numeric, art_median numeric, art_avg numeric, samples integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc) then return; end if;
  if reports_hidden(acc) then return; end if;
  if not is_account_member(acc, 'admin') then p_agent_id := auth.uid(); end if;

  return query
  with msgs as (
    select m.conversation_id, m.sender_type, m.sender_id, m.assigned_agent_id,
           m.created_at, m.id, c.connection_id
    from messages m
    join conversations c on c.id = m.conversation_id
    where c.account_id = acc
      and (p_connection_id is null or c.connection_id = p_connection_id)
      and m.created_at >= now() - make_interval(days => p_window_days)
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
$function$;

CREATE OR REPLACE FUNCTION public.agent_volume(p_window_days integer DEFAULT 30, p_connection_id uuid DEFAULT NULL::uuid, p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(agent_id uuid, conversas_atendidas integer, msgs_enviadas integer, transferencias integer, handoffs_ia integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc) then return; end if;
  if reports_hidden(acc) then return; end if;
  if not is_account_member(acc, 'admin') then p_agent_id := auth.uid(); end if;

  return query
  with am as (
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
  conv_scope as (
    select id from conversations
    where account_id = acc and (p_connection_id is null or connection_id = p_connection_id)
  ),
  tr as (
    select actor_user_id as resp_agent, count(*)::int as n
    from conversation_events
    where account_id = acc and type = 'transferred' and actor_user_id is not null
      and created_at >= now() - make_interval(days => p_window_days)
      and conversation_id in (select id from conv_scope)
    group by actor_user_id
  ),
  ho as (
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
$function$;

CREATE OR REPLACE FUNCTION public.agent_sales(p_window_days integer DEFAULT 30, p_connection_id uuid DEFAULT NULL::uuid, p_agent_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(agent_id uuid, vendas integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc) then return; end if;
  if reports_hidden(acc) then return; end if;
  if not is_account_member(acc, 'admin') then p_agent_id := auth.uid(); end if;

  return query
  select s.atendente_id as agent_id, count(*)::int as vendas
  from attributed_sales s
  where s.account_id = acc
    and s.status = 'confirmed'
    and s.atendente_id is not null
    and s.data_matricula >= (now() - make_interval(days => p_window_days))::date
    and (p_connection_id is null or s.connection_id = p_connection_id)
    and (p_agent_id is null or s.atendente_id = p_agent_id)
  group by s.atendente_id;
end;
$function$;
