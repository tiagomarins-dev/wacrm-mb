-- 066_message_link_click_count.sql
-- Contagem de cliques do link rastreável enviado NESTA mensagem (badge realtime).
-- messages já está na publicação realtime (001) → o UPDATE chega no client de graça.
alter table messages add column if not exists link_click_count int not null default 0;

-- Incrementa a msg OUTBOUND que carrega o token (content_text tem /r/<token>). O token
-- 32-hex é único → 1 linha. sender_type in ('agent','bot'): mensagem inbound do cliente
-- que cita o link não conta. security definer: chamada pela rota /r via service role.
create or replace function increment_message_link_clicks(p_token text)
returns void language sql security definer set search_path = public as $$
  update messages
  set link_click_count = link_click_count + 1
  where content_text like '%/r/' || p_token || '%'
    and sender_type in ('agent','bot');
$$;

-- Função nasce com EXECUTE p/ PUBLIC; revogar de PUBLIC fecha todos os roles do PostgREST.
-- A rota usa service_role (ignora grants) → continua funcionando.
revoke execute on function increment_message_link_clicks(text) from public;
