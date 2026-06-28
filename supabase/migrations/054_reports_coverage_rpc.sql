-- ============================================================
-- 054_reports_coverage_rpc.sql — RPCs admin de cobertura e lista de vendas (Fase 3).
-- SECURITY DEFINER account-scoped via auth.uid(); admin-only. Espelha 050/052.
-- ============================================================

-- Cobertura: match rate da MB (student_info) + % de conversas classificadas.
create or replace function report_coverage(
  p_window_days int default 30, p_connection_id uuid default null
) returns table(matched int, no_match int, ambiguous int, convs_total int, convs_classified int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc, 'admin') then return; end if;
  return query
  select
    (select count(*)::int from student_info si where si.account_id = acc and si.status = 'success'),
    (select count(*)::int from student_info si where si.account_id = acc and si.status = 'nao_encontrado'),
    (select count(*)::int from student_info si where si.account_id = acc and si.status = 'multiplos'),
    (select count(*)::int from conversations c where c.account_id = acc
       and (p_connection_id is null or c.connection_id = p_connection_id)
       and c.last_message_at >= now() - make_interval(days => p_window_days)),
    (select count(*)::int from conversations c where c.account_id = acc
       and (p_connection_id is null or c.connection_id = p_connection_id)
       and c.last_message_at >= now() - make_interval(days => p_window_days)
       and c.report_intent is not null);
end;
$$;

-- Lista de vendas atribuídas (admin) p/ a UI de override. Paginada, cap 200.
create or replace function report_attributed_sales(
  p_window_days int default 30, p_connection_id uuid default null,
  p_status text default 'confirmed', p_limit int default 100, p_offset int default 0
) returns table(
  id uuid, contact_name text, nome_curso text, atendente_id uuid,
  data_matricula date, status text, confidence text, sale_type text
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid; lim int;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc, 'admin') then return; end if;
  lim := least(greatest(p_limit, 1), 200);  -- cap defensivo
  return query
  select s.id, ct.name, s.nome_curso, s.atendente_id, s.data_matricula, s.status, s.confidence, s.sale_type
  from attributed_sales s
  join contacts ct on ct.id = s.contact_id
  where s.account_id = acc
    and (p_status is null or s.status = p_status)
    and (p_connection_id is null or s.connection_id = p_connection_id)
    and s.data_matricula >= (now() - make_interval(days => p_window_days))::date
  order by s.data_matricula desc
  limit lim offset greatest(p_offset, 0);
end;
$$;

grant execute on function report_coverage(int, uuid) to authenticated;
grant execute on function report_attributed_sales(int, uuid, text, int, int) to authenticated;
revoke execute on function report_coverage(int, uuid) from anon;
revoke execute on function report_attributed_sales(int, uuid, text, int, int) from anon;
