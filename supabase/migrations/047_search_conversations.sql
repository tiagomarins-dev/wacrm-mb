-- ============================================================
-- Busca/filtro da tela Conversas (/conversations).
-- Índices trigram (pg_trgm) p/ ILIKE rápido em nome/telefone/conteúdo de
-- mensagem/transcrição, + índice do filtro por responsável, + a RPC
-- search_conversations que faz filtro + busca + paginação + count numa só
-- passada (count(*) over()).
-- SECURITY INVOKER de propósito: a RLS de conversations/contacts/messages
-- (is_account_member(account_id), mig 017) já restringe por conta no contexto
-- do usuário logado. Diferente de 031_lead_score (DEFINER) — mas, como a 031,
-- esta RPC NUNCA aceita account_id por parâmetro: a conta vem da sessão/RLS.
-- p_search entra só em ILIKE parametrizado (sem SQL dinâmico).
-- Idempotente; sem rollback (padrão do repo, ex. 046). create extension é
-- irreversível na prática.
-- ============================================================
create extension if not exists pg_trgm;

-- Índices trigram p/ ILIKE '%termo%' (busca por nome/telefone/conteúdo).
create index if not exists idx_messages_content_text_trgm
  on messages using gin (content_text gin_trgm_ops);
-- Transcrição de áudio (mig 046) também entra na busca. Índice parcial: a
-- maioria das mensagens tem transcription null.
create index if not exists idx_messages_transcription_trgm
  on messages using gin (transcription gin_trgm_ops) where transcription is not null;
create index if not exists idx_contacts_name_trgm  on contacts using gin (name  gin_trgm_ops);
create index if not exists idx_contacts_phone_trgm on contacts using gin (phone gin_trgm_ops);
-- Filtro por responsável sem seq scan em conta grande.
create index if not exists idx_conversations_assigned_agent
  on conversations(assigned_agent_id, last_message_at desc);

-- RPC de busca/listagem paginada da tela Conversas. Devolve cada conversa já
-- com o contato embutido (mesmo shape do select("*, contact:contacts(*)")) +
-- o total do conjunto filtrado (p/ a paginação), tudo numa passada.
create or replace function search_conversations(
  p_search text default null,
  p_status text default null,
  p_agent uuid default null,
  p_unassigned boolean default false,
  p_connection uuid default null,
  p_limit int default 25,
  p_offset int default 0
) returns table(data jsonb, total_count int)
language sql stable security invoker set search_path = public as $$
  with filtered as (
    -- Aplica conexão/status/responsável + a busca (contato OU conteúdo de msg).
    select c.id, c.contact_id, c.last_message_at
    from conversations c
    where (p_connection is null or c.connection_id = p_connection)
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
    -- count(*) over() = total do conjunto filtrado ANTES do limit (paginação correta).
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

grant execute on function search_conversations(text,text,uuid,boolean,uuid,int,int) to authenticated;
revoke execute on function search_conversations(text,text,uuid,boolean,uuid,int,int) from anon;
