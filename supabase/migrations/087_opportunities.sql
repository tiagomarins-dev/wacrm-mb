-- ============================================================
-- 087_opportunities.sql — Tela Oportunidades (comercial).
-- Lista quem teve sinal de compra (clique no checkout, "vai decidir"/"preço",
-- carrinho abandonado) e ainda não comprou o curso do sinal. Compra = tags de
-- matriculado mantidas pelo mb-sync (086). Tudo leitura, exceto o job da tag.
-- ============================================================

-- Carrinho abandonado da Hotmart. PROVISIONADA: a integração que grava (via
-- service-role) ainda não existe. Associar ao contato é tarefa dela.
create table if not exists hotmart_abandoned_carts (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  source_event_id text not null,          -- id de origem do carrinho (não duplica)
  product_code text,                      -- código do produto Hotmart
  abandoned_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (account_id, source_event_id)
);
create index if not exists idx_hotmart_carts_contact
  on hotmart_abandoned_carts(account_id, contact_id, abandoned_at desc);
alter table hotmart_abandoned_carts enable row level security;
-- PII do comprador: só agent+ lê; sem policy de escrita.
drop policy if exists hotmart_abandoned_carts_read on hotmart_abandoned_carts;
create policy hotmart_abandoned_carts_read on hotmart_abandoned_carts
  for select using (is_account_member(account_id, 'agent'));

-- De→para produto Hotmart (código do checkout) → cursos da plataforma.
-- Combo = vários cursos: comprou só quando tem TODOS.
create table if not exists mb_checkout_products (
  account_id uuid not null references accounts(id) on delete cascade,
  product_code text not null,
  nome text,
  mb_course_ids integer[] not null,
  created_at timestamptz not null default now(),
  primary key (account_id, product_code)
);
alter table mb_checkout_products enable row level security;
drop policy if exists mb_checkout_products_read on mb_checkout_products;
create policy mb_checkout_products_read on mb_checkout_products
  for select using (is_account_member(account_id));
drop policy if exists mb_checkout_products_write on mb_checkout_products;
create policy mb_checkout_products_write on mb_checkout_products for all
  using (is_account_member(account_id, 'admin')) with check (is_account_member(account_id, 'admin'));

-- último link enviado por contato ("vai decidir" herda o produto dele)
create index if not exists idx_link_tokens_contact on link_tokens(contact_id, created_at desc);
-- casamento de compra por variante de telefone entre conexões da conta
create index if not exists idx_contacts_account_phone_norm on contacts(account_id, phone_normalized);

-- Chaves de telefone em ordem de prioridade: exata → variante do 9º dígito →
-- sem 55 → variante sem 55. Canoniza antes (12/13 dígitos com 55 ficam; 10/11
-- ganham 55). Não-BR → '{}'. MANTER EM SINCRONIA com toCanonicalBr + phoneKeys.
create or replace function mb_phone_keys(p_phone text)
returns text[] language plpgsql immutable set search_path = public as $$
declare
  d text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  c text; v text; ddd text; rest text;
begin
  if length(d) in (12, 13) and left(d, 2) = '55' then c := d;
  elsif length(d) in (10, 11) and left(d, 1) <> '0' then c := '55' || d;
  else return '{}';
  end if;
  -- variante do 9º dígito (espelha brPhoneNinthDigitVariant, phone-utils.ts:41-48)
  ddd := substr(c, 3, 2); rest := substr(c, 5);
  if length(rest) = 9 and left(rest, 1) = '9' then v := '55' || ddd || substr(rest, 2);
  elsif length(rest) = 8 then v := '55' || ddd || '9' || rest;
  end if;
  return array_remove(array[c, v, substr(c, 3), substr(v, 3)], null);
end $$;

-- Sinais de compra por contato. p_source: 'all' | 'click' | 'cart' (intent só em
-- 'all'). p_window_days nulo = sem janela (usado para decidir remoção da tag).
-- O sinal mais recente define signal_at e o produto.
create or replace function opportunity_signals(p_account_id uuid, p_source text, p_window_days int)
returns table(contact_id uuid, signal_types text[], signal_at timestamptz,
              click_count int, loss_reason text, product_code text)
language sql stable security definer set search_path = public as $$
  with since as (
    select case when p_window_days is null then '-infinity'::timestamptz
                else now() - make_interval(days => p_window_days) end as t
  ),
  clicks as (   -- clique real no checkout; produto = link clicado
    select lc.contact_id, count(*)::int as n, max(lc.clicked_at) as at,
      (array_agg(substring(lc.target_url from 'pay\.hotmart\.com/([A-Za-z0-9]+)')
         order by lc.clicked_at desc))[1] as product
    from link_clicks lc, since
    where lc.account_id = p_account_id and lc.contact_id is not null
      and lc.target_url ilike 'https://pay.hotmart.com/%'
      and lc.clicked_at >= since.t and p_source in ('all', 'click')
    group by lc.contact_id
  ),
  intents as (  -- classificador: vendas + vai_decidir/preco; data = última msg do cliente
    select cv.contact_id, max(m.created_at) as at,
      (array_agg(cv.report_loss_reason order by m.created_at desc))[1] as reason
    from conversations cv
    join messages m on m.conversation_id = cv.id and m.sender_type = 'customer'
    cross join since
    where cv.account_id = p_account_id and cv.contact_id is not null
      and cv.report_intent = 'vendas' and cv.report_loss_reason in ('vai_decidir', 'preco')
      and m.created_at >= since.t and p_source = 'all'
    group by cv.contact_id
  ),
  last_link as ( -- produto do último link de checkout enviado (para intents)
    select distinct on (lt.contact_id) lt.contact_id,
      substring(lt.url from 'pay\.hotmart\.com/([A-Za-z0-9]+)') as product
    from link_tokens lt
    where lt.account_id = p_account_id and lt.url ilike '%pay.hotmart.com/%'
      and lt.contact_id in (select i.contact_id from intents i)
    order by lt.contact_id, lt.created_at desc
  ),
  carts as (    -- provisionado: só carrinhos já associados a contato
    select hc.contact_id, max(hc.abandoned_at) as at,
      (array_agg(hc.product_code order by hc.abandoned_at desc))[1] as product
    from hotmart_abandoned_carts hc, since
    where hc.account_id = p_account_id and hc.contact_id is not null
      and hc.abandoned_at >= since.t and p_source in ('all', 'cart')
    group by hc.contact_id
  ),
  unioned as (
    select c.contact_id, 'click'::text as t, c.at, c.product from clicks c
    union all
    select i.contact_id, 'intent', i.at, ll.product from intents i left join last_link ll using (contact_id)
    union all
    select k.contact_id, 'cart', k.at, k.product from carts k
  )
  select u.contact_id,
    array_agg(distinct u.t order by u.t),
    max(u.at),
    coalesce((select c.n from clicks c where c.contact_id = u.contact_id), 0),
    (select i.reason from intents i where i.contact_id = u.contact_id),
    (array_agg(u.product order by u.at desc))[1]
  from unioned u
  group by u.contact_id
$$;

-- Cursos que o contato (ou outro contato da conta com telefone por variante) tem,
-- contando só tags ligadas a UM único curso em mb_class_sync (tag multi-curso
-- não prova compra de um curso específico).
create or replace function opportunity_owned_courses(p_account_id uuid, p_contact_ids uuid[])
returns table(contact_id uuid, courses int[])
language sql stable security definer set search_path = public as $$
  with valid_tags as (
    select s.tag_id, min(s.mb_course_id) as mb_course_id
    from mb_class_sync s
    where s.account_id = p_account_id
    group by s.tag_id
    having count(distinct s.mb_course_id) = 1
  ),
  targets as (
    select c.id, c.phone from contacts c
    where c.account_id = p_account_id and c.id = any(p_contact_ids)
  ),
  -- o próprio contato + os da conta com telefone por variante. Expande as chaves e
  -- junta por igualdade para usar idx_contacts_account_phone_norm: um OR com
  -- "= any(...)" impede o índice e varre todos os contatos da conta.
  related as (
    select t.id as target_id, t.id as contact_id from targets t
    union
    select t.id, o.id
    from targets t
    cross join lateral unnest(mb_phone_keys(t.phone)) as k(key)
    join contacts o on o.account_id = p_account_id and o.phone_normalized = k.key
  )
  select r.target_id, array_agg(distinct vt.mb_course_id)
  from related r
  join contact_tags ct on ct.contact_id = r.contact_id
  join valid_tags vt on vt.tag_id = ct.tag_id
  group by r.target_id
$$;

-- Lista de oportunidades da conta. Exclui quem comprou TODOS os cursos do produto
-- do sinal e quem tem a tag 'bloqueado'. Score (fórmula de 031:86-87) só dos
-- candidatos. p_connection_id: só contatos com conversa nessa conexão.
create or replace function opportunities_for_account(p_account_id uuid, p_source text, p_connection_id uuid)
returns table(contact_id uuid, name text, phone text, conversation_id uuid, assigned_agent_id uuid,
              signal_types text[], signal_at timestamptz, click_count int, loss_reason text,
              product_code text, course_name text, bucket text, is_student_other_course boolean,
              approached_at timestamptz, approached_by_name text, score int, classification text)
language sql stable security definer set search_path = public as $$
  with cfg as (
    select coalesce(max(msg_weight), 1) as w_msg, coalesce(max(button_weight), 3) as w_btn,
           coalesce(max(link_weight), 5) as w_link, coalesce(max(sale_multiplier), 2) as mult,
           coalesce(max(hot_threshold), 50) as hot, coalesce(max(warm_threshold), 20) as warm
    from lead_score_config where account_id = p_account_id
  ),
  sg as (select * from opportunity_signals(p_account_id, p_source, 30)),
  owned as (
    select * from opportunity_owned_courses(p_account_id, (select coalesce(array_agg(x.contact_id), '{}') from sg x))
  ),
  blocked as (
    select ct.contact_id from contact_tags ct join tags t on t.id = ct.tag_id
    where t.account_id = p_account_id and lower(t.name) = 'bloqueado'
  ),
  base as materialized (
    select sg.*, c.name as contact_name, c.phone as contact_phone, p.nome as product_name,
           p.mb_course_ids, coalesce(ow.courses, '{}') as owned_courses
    from sg
    join contacts c on c.id = sg.contact_id and c.account_id = p_account_id
    left join mb_checkout_products p on p.account_id = p_account_id and p.product_code = sg.product_code
    left join owned ow on ow.contact_id = sg.contact_id
    where sg.contact_id not in (select b.contact_id from blocked b)
      -- produto mapeado e todos os cursos já possuídos = comprou → fora
      and not (p.mb_course_ids is not null and p.mb_course_ids <@ coalesce(ow.courses, '{}'))
  ),
  cand_conv as materialized ( -- conversas dos candidatos (todas as conexões), lidas uma vez
    select cv.id, cv.contact_id, cv.connection_id, cv.assigned_agent_id, cv.updated_at
    from conversations cv
    where cv.account_id = p_account_id and cv.contact_id in (select b.contact_id from base b)
  ),
  conv as (   -- conversa mais recente (da conexão pedida, quando houver)
    select distinct on (cc.contact_id) cc.contact_id, cc.id, cc.assigned_agent_id
    from cand_conv cc
    where p_connection_id is null or cc.connection_id = p_connection_id
    order by cc.contact_id, cc.updated_at desc nulls last
  ),
  approached as ( -- última mensagem humana depois do sinal (bot não conta)
    select distinct on (b.contact_id) b.contact_id, m.created_at, pr.full_name
    from base b
    join cand_conv cc on cc.contact_id = b.contact_id
    join messages m on m.conversation_id = cc.id and m.sender_type = 'agent' and m.created_at > b.signal_at
    left join profiles pr on pr.user_id = m.sender_id
    order by b.contact_id, m.created_at desc
  ),
  msg as (    -- score só dos candidatos (janela 30 dias)
    select cc.contact_id,
      count(*) filter (where m.interactive_reply_id is null)::int as msgs,
      count(*) filter (where m.interactive_reply_id is not null)::int as btns
    from cand_conv cc join messages m on m.conversation_id = cc.id
    where m.sender_type = 'customer' and m.created_at >= now() - interval '30 days'
    group by cc.contact_id
  ),
  lk as (
    select lc.contact_id, count(*)::int as links, count(*) filter (where lc.is_sale)::int as sales
    from link_clicks lc
    where lc.account_id = p_account_id and lc.contact_id in (select b.contact_id from base b)
      and lc.clicked_at >= now() - interval '30 days'
    group by lc.contact_id
  )
  select b.contact_id, b.contact_name, b.contact_phone, cv.id, cv.assigned_agent_id,
    b.signal_types, b.signal_at, b.click_count, b.loss_reason, b.product_code, b.product_name,
    case when b.signal_at >= now() - interval '5 days' then 'recent' else 'old' end,
    exists (select 1 from unnest(b.owned_courses) x where not (x = any(coalesce(b.mb_course_ids, '{}')))),
    ap.created_at, ap.full_name,
    s.sc,
    case when s.sc >= cfg.hot then 'quente' when s.sc >= cfg.warm then 'morno' else 'frio' end
  from base b
  cross join cfg
  left join conv cv on cv.contact_id = b.contact_id
  left join approached ap on ap.contact_id = b.contact_id
  left join msg on msg.contact_id = b.contact_id
  left join lk on lk.contact_id = b.contact_id
  cross join lateral (
    select (coalesce(msg.msgs, 0) * cfg.w_msg + coalesce(msg.btns, 0) * cfg.w_btn
      + (coalesce(lk.links, 0) - coalesce(lk.sales, 0)) * cfg.w_link
      + coalesce(lk.sales, 0) * round(cfg.w_link * cfg.mult))::int as sc
  ) s
  where p_connection_id is null or cv.id is not null
$$;

-- Dentre os ids, quem comprou TODOS os cursos do produto do último sinal (sem
-- janela: quem vira oportunidade e compra depois de 30 dias também sai da tag).
-- Produto sem cadastro em mb_checkout_products nunca conta como comprado.
create or replace function opportunity_purchased(p_account_id uuid, p_contact_ids uuid[])
returns table(contact_id uuid)
language sql stable security definer set search_path = public as $$
  with sg as (
    select * from opportunity_signals(p_account_id, 'all', null) s
    where s.contact_id = any(p_contact_ids)
  ),
  owned as (select * from opportunity_owned_courses(p_account_id, p_contact_ids))
  select sg.contact_id
  from sg
  join mb_checkout_products p on p.account_id = p_account_id and p.product_code = sg.product_code
  join owned ow on ow.contact_id = sg.contact_id
  where p.mb_course_ids <@ ow.courses
$$;

-- Lista da tela. Conta por auth.uid() (sem account_id por param). agent+ vê
-- todos; NÃO restringe ao próprio (decisão de produto). Acesso negado / parâmetro
-- inválido → vazio, sem raise.
create or replace function opportunities(
  p_bucket text, p_source text default 'all', p_connection_id uuid default null,
  p_filter text default 'all', p_limit int default 50, p_offset int default 0
) returns table(contact_id uuid, name text, phone text, conversation_id uuid, assigned_agent_id uuid,
                signal_types text[], signal_at timestamptz, click_count int, loss_reason text,
                product_code text, course_name text, bucket text, is_student_other_course boolean,
                approached_at timestamptz, approached_by_name text, score int, classification text,
                total_count int)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid;
begin
  select p.account_id into acc from profiles p where p.user_id = auth.uid();
  if acc is null or not is_account_member(acc, 'agent') then return; end if;
  if p_bucket not in ('recent', 'old') or p_source not in ('all', 'click', 'cart')
     or p_filter not in ('all', 'mine', 'unassigned') then return; end if;
  p_limit := least(greatest(coalesce(p_limit, 50), 1), 200);
  p_offset := greatest(coalesce(p_offset, 0), 0);

  return query
  select o.contact_id, o.name, o.phone, o.conversation_id, o.assigned_agent_id,
    o.signal_types, o.signal_at, o.click_count, o.loss_reason, o.product_code, o.course_name,
    o.bucket, o.is_student_other_course, o.approached_at, o.approached_by_name, o.score,
    o.classification, (count(*) over())::int
  from opportunities_for_account(acc, p_source, p_connection_id) o
  where o.bucket = p_bucket
    and (p_filter = 'all'
      or (p_filter = 'mine' and o.assigned_agent_id = auth.uid())
      -- IA (bot sentinela ou perfil de IA) conta como livre para o comercial humano
      or (p_filter = 'unassigned' and (o.assigned_agent_id is null
          or o.assigned_agent_id = '00000000-0000-0000-0000-0000000000a1'
          or exists (select 1 from ai_profiles ap where ap.account_id = acc and ap.id = o.assigned_agent_id))))
  order by (o.approached_at is not null),
    case when p_bucket = 'old' then o.score end desc nulls last,
    o.signal_at desc, o.contact_id
  limit p_limit offset p_offset;
end $$;

-- Existe algum carrinho abandonado na conta? (aviso de integração na tela)
create or replace function opportunities_has_cart_data()
returns boolean language plpgsql stable security definer set search_path = public as $$
declare acc uuid;
begin
  select p.account_id into acc from profiles p where p.user_id = auth.uid();
  if acc is null or not is_account_member(acc, 'agent') then return false; end if;
  return exists (select 1 from hotmart_abandoned_carts h where h.account_id = acc);
end $$;

-- Internas recebem account_id por parâmetro: NUNCA expostas ao PostgREST.
-- Revogar só de PUBLIC não basta no Supabase (anon/authenticated recebem grant
-- padrão); padrão de 007:32-35.
revoke all on function mb_phone_keys(text) from public, anon, authenticated;
revoke all on function opportunity_signals(uuid, text, int) from public, anon, authenticated;
revoke all on function opportunity_owned_courses(uuid, uuid[]) from public, anon, authenticated;
revoke all on function opportunities_for_account(uuid, text, uuid) from public, anon, authenticated;
revoke all on function opportunity_purchased(uuid, uuid[]) from public, anon, authenticated;
grant execute on function opportunities_for_account(uuid, text, uuid) to service_role;
grant execute on function opportunity_purchased(uuid, uuid[]) to service_role;

grant execute on function opportunities(text, text, uuid, text, int, int) to authenticated;
revoke execute on function opportunities(text, text, uuid, text, int, int) from anon;
grant execute on function opportunities_has_cart_data() to authenticated;
revoke execute on function opportunities_has_cart_data() from anon;
