-- 083_broadcast_tag_name.sql
-- Nome da tag aplicada a quem RECEBE o disparo.
-- Precisa morar na broadcast (e não só no payload do assistente) porque o envio
-- AGENDADO acontece depois, no cron: quando o send-engine roda, o wizard já
-- fechou e a única fonte da configuração é a própria linha.
alter table broadcasts add column if not exists tag_name text;

comment on column broadcasts.tag_name is
  'Tag aplicada aos contatos que receberam o disparo (status sent). Null = não marca.';
