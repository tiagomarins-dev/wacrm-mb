-- ============================================================
-- Perf da tela /conversations: a search_conversations (047) era
-- SECURITY INVOKER e NÃO filtrava account_id no SQL — dependia da RLS
-- is_account_member(account_id) (017), avaliada LINHA A LINHA sobre
-- conversations/contacts/messages. Com centenas de conversas + joins,
-- estourava o statement_timeout de 8s do papel `authenticated` → 500
-- ("canceling statement due to statement timeout", 57014). Com service_role
-- (sem RLS) rodava em ~0,6s → prova que o gargalo é a RLS por-linha.
--
-- Correção: recriar como SECURITY DEFINER derivando a conta do usuário UMA vez
-- (profiles por auth.uid()) e filtrando c.account_id no SQL — em vez de pagar
-- is_account_member por linha. Mesmo padrão da 031_lead_score (DEFINER).
-- Seguro: search_path travado, NÃO aceita account_id por parâmetro (vem da
-- sessão via auth.uid()), guard explícito de conta → sem vazamento entre contas.
-- + índice (account_id, last_message_at desc) p/ filtro+ordenação.
-- Idempotente (create or replace / index if not exists). Reverter = reaplicar 047.
-- ============================================================

-- Índice do caminho quente: filtra por conta e ordena por last_message_at desc.
create index if not exists idx_conversations_account_lastmsg
  on conversations(account_id, last_message_at desc);

create or replace function search_conversations(
  p_search text default null,
  p_status text default null,
  p_agent uuid default null,
  p_unassigned boolean default false,
  p_connection uuid default null,
  p_limit int default 25,
  p_offset int default 0
) returns table(data jsonb, total_count int)
language sql stable security definer set search_path = public as $$
  with me as (
    -- Conta(s) do usuário logado — derivada UMA vez. auth.uid() vem do JWT do
    -- CHAMADOR mesmo sob DEFINER, então o guard escopa corretamente à sessão.
    select account_id from profiles where user_id = auth.uid()
  ), filtered as (
    -- Guard de conta no SQL (substitui a RLS por-linha) + filtros + busca.
    select c.id, c.contact_id, c.last_message_at
    from conversations c
    where c.account_id in (select account_id from me)
      and (p_connection is null or c.connection_id = p_connection)
      and (p_status is null or c.status = p_status)
      and (not p_unassigned or c.assigned_agent_id is null)
      and (p_agent is null or c.assigned_agent_id = p_agent)
      and (coalesce(p_search, '') = ''
        or c.last_message_text ilike '%' || p_search || '%'
        or exists (select 1 from contacts ct where ct.id = c.contact_id
                   and (ct.name ilike '%' || p_search || '%'
                        or ct.phone ilike '%' || p_search || '%'))
        or exists (select 1 from messages m where m.conversation_id = c.id
                   and (m.content_text ilike '%' || p_search || '%'
                        or m.transcription ilike '%' || p_search || '%')))
  ), counted as (
    -- count(*) over() = total do conjunto filtrado ANTES do limit (paginação).
    select id, contact_id, last_message_at, count(*) over()::int as total_count
    from filtered
  )
  select to_jsonb(c) || jsonb_build_object('contact', to_jsonb(ct)) as data,
         k.total_count
  from counted k
  join conversations c on c.id = k.id
  left join contacts ct on ct.id = k.contact_id
  order by k.last_message_at desc nulls last
  limit p_limit offset p_offset;
$$;

alter function search_conversations(text,text,uuid,boolean,uuid,int,int) owner to postgres;
grant execute on function search_conversations(text,text,uuid,boolean,uuid,int,int) to authenticated;
revoke execute on function search_conversations(text,text,uuid,boolean,uuid,int,int) from anon;
