-- ============================================================
-- 077: RPC pulse_agent_hourly — mensagens de HUMANOS por hora do
-- dia (0-23, fuso America/Sao_Paulo) × content_type, na janela.
-- OWNER-only (guard literal da 071). Diverge do padrão is_ai da 072
-- DE PROPÓSITO: esta RPC é só de atendentes humanos
-- (sender_type='agent'); p_agent_id apontando pra perfil de IA
-- retorna vazio por construção — com o residual legado aceito de
-- msgs pré-trigger 024 (sender_id null) em conversas então
-- atribuídas à IA. Gap-filling das 24h é do FRONT (bucketHourly).
-- ============================================================
create or replace function pulse_agent_hourly(
  p_from timestamptz,
  p_to timestamptz,
  p_agent_id uuid default null,
  p_connection_id uuid default null
) returns table(hora int, content_type text, msgs int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null then return; end if;
  -- OWNER apenas (denormalizado em accounts.owner_user_id, 017 — padrão 065). Admin/agent → vazio.
  if not exists (select 1 from accounts a where a.id = acc and a.owner_user_id = auth.uid()) then return; end if;
  -- clamp de range: máx 400 dias (mitiga query pesada arbitrária)
  p_from := greatest(p_from, p_to - interval '400 days');

  return query
  select extract(hour from (m.created_at at time zone 'America/Sao_Paulo'))::int as hora,
         m.content_type,
         count(*)::int as msgs
  from messages m
  join conversations c on c.id = m.conversation_id
  where c.account_id = acc
    and (p_connection_id is null or c.connection_id = p_connection_id)
    and m.created_at >= p_from and m.created_at < p_to
    and m.sender_type = 'agent'
    and (p_agent_id is null or coalesce(m.sender_id, m.assigned_agent_id) = p_agent_id)
  group by 1, 2
  order by 1, 2;
end;
$$;

grant execute on function pulse_agent_hourly(timestamptz, timestamptz, uuid, uuid) to authenticated;
revoke execute on function pulse_agent_hourly(timestamptz, timestamptz, uuid, uuid) from anon;
