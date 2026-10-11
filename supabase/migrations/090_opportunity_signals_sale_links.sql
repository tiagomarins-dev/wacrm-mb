-- ============================================================
-- 090_opportunity_signals_sale_links.sql — sinal de clique de Oportunidades
-- aceita qualquer link de venda.
--
-- Conta como sinal o clique no checkout da Hotmart ou em link marcado como de
-- venda (link_clicks.is_sale), o que inclui curso vendido por encurtador ou
-- página própria. Nesse segundo caso a URL não traz o código do produto:
-- product_code fica NULL, a tela mostra o curso como desconhecido e o contato
-- não sai da tag 'oportunidade' por compra (opportunity_purchased exige produto
-- cadastrado em mb_checkout_products).
--
-- Só o CTE `clicks` difere da definição da 087. Idempotente.
-- ============================================================

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
  clicks as (   -- clique em link de venda; produto = código do checkout, quando houver
    select lc.contact_id, count(*)::int as n, max(lc.clicked_at) as at,
      (array_agg(substring(lc.target_url from 'pay\.hotmart\.com/([A-Za-z0-9]+)')
         order by lc.clicked_at desc))[1] as product
    from link_clicks lc, since
    where lc.account_id = p_account_id and lc.contact_id is not null
      and (lc.is_sale or lc.target_url ilike 'https://pay.hotmart.com/%')
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
