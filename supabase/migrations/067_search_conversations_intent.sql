-- ============================================================
-- Filtro por INTENÇÃO classificada em /conversations. Estende search_conversations
-- (mig 063): + p_intent text. report_intent (053) é 'vendas'|'suporte'|'outro'|NULL.
-- '__none__' = não classificada (NULL). Assinatura muda → DROP(10 args) + CREATE(11)
-- + re-grant. Mantém SECURITY DEFINER + guard de conta. Idempotente. Reverter = reaplicar 063.
-- ============================================================
drop function if exists search_conversations(text,text,uuid,boolean,uuid,timestamptz,timestamptz,uuid,int,int);

create or replace function search_conversations(
  p_search text default null,
  p_status text default null,
  p_agent uuid default null,
  p_unassigned boolean default false,
  p_connection uuid default null,
  p_date_from timestamptz default null,
  p_date_to timestamptz default null,
  p_tag uuid default null,
  p_intent text default null,
  p_limit int default 25,
  p_offset int default 0
) returns table(data jsonb, total_count int)
language sql stable security definer set search_path = public as $$
  with me as (
    select account_id from profiles where user_id = auth.uid()
  ), filtered as (
    select c.id, c.contact_id, c.last_message_at
    from conversations c
    where c.account_id in (select account_id from me)
      and (p_date_from is null or c.last_message_at >= p_date_from)
      and (p_date_to   is null or c.last_message_at <= p_date_to)
      and (p_connection is null or c.connection_id = p_connection)
      and (p_status is null or c.status = p_status)
      and (not p_unassigned or c.assigned_agent_id is null)
      and (p_agent is null or c.assigned_agent_id = p_agent)
      -- Filtro por tag do contato (via contact_tags; grupo sem contato some).
      and (p_tag is null or exists (
        select 1 from contact_tags ct
        where ct.contact_id = c.contact_id and ct.tag_id = p_tag))
      -- Filtro por intenção classificada (report_intent, 053). '__none__' = não classificada (NULL).
      and (
        p_intent is null
        or (p_intent = '__none__' and c.report_intent is null)
        or c.report_intent = p_intent
      )
      and (coalesce(p_search, '') = ''
        or c.last_message_text ilike '%' || p_search || '%'
        or exists (select 1 from contacts ct where ct.id = c.contact_id
                   and (ct.name ilike '%' || p_search || '%'
                        or ct.phone ilike '%' || p_search || '%'))
        or exists (select 1 from messages m where m.conversation_id = c.id
                   and (m.content_text ilike '%' || p_search || '%'
                        or m.transcription ilike '%' || p_search || '%')))
  ), counted as (
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

alter function search_conversations(text,text,uuid,boolean,uuid,timestamptz,timestamptz,uuid,text,int,int) owner to postgres;
grant execute on function search_conversations(text,text,uuid,boolean,uuid,timestamptz,timestamptz,uuid,text,int,int) to authenticated;
revoke execute on function search_conversations(text,text,uuid,boolean,uuid,timestamptz,timestamptz,uuid,text,int,int) from anon;
