-- ============================================================
-- 052_agent_sales_rpc.sql — RPC de vendas atribuídas por atendente (Fase 2).
-- Espelha 050_agent_report_rpcs.sql: SECURITY DEFINER account-scoped via auth.uid(),
-- força p_agent_id ao próprio caller quando não-admin (operador não vê outro).
-- Conta só status='confirmed' e atendente_id não-nulo (só-IA/sem humano não conta).
-- ============================================================
create or replace function agent_sales(
  p_window_days int default 30,
  p_connection_id uuid default null,
  p_agent_id uuid default null
) returns table(agent_id uuid, vendas int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc) then return; end if;
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
$$;

grant execute on function agent_sales(int, uuid, uuid) to authenticated;
revoke execute on function agent_sales(int, uuid, uuid) from anon;
