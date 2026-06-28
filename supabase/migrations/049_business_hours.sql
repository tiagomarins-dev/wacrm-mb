-- ============================================================
-- 049_business_hours.sql — horário de atendimento por conexão.
-- Base do "tempo de resposta limpo": as RPCs de relatório clipam os intervalos
-- a estas janelas (mensagem fora do expediente não infla o tempo).
-- 1 linha por (conta, conexão). Leitura member; escrita admin.
-- schedule (schema NOVO): jsonb array [{dow,enabled,open:'HH:MM',close:'HH:MM'}]
--   dow 0=dom..6=sáb. Janela same-day (open<close); overnight não suportado na v1.
-- ============================================================
create table if not exists business_hours (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  connection_id uuid not null references whatsapp_config(id) on delete cascade,
  timezone text not null default 'America/Sao_Paulo',
  schedule jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(account_id, connection_id)
);
alter table business_hours enable row level security;
drop policy if exists business_hours_read on business_hours;
create policy business_hours_read on business_hours for select
  using (is_account_member(account_id));
drop policy if exists business_hours_write on business_hours;
create policy business_hours_write on business_hours for all
  using (is_account_member(account_id, 'admin'))
  with check (is_account_member(account_id, 'admin'));

-- updated_at automático (update_updated_at_column() existe desde 001).
drop trigger if exists set_updated_at on business_hours;
create trigger set_updated_at before update on business_hours
  for each row execute function update_updated_at_column();

-- Soma os segundos DENTRO do expediente entre 2 timestamps (clipping). stable.
-- Sem schedule → diff bruto (24/7, fallback). Janela same-day (open<close).
-- ⚠️ ESPELHADO em src/lib/reports/business-hours.ts — mude nos dois.
create or replace function business_seconds_between(
  p_start timestamptz, p_end timestamptz, p_schedule jsonb, p_tz text
) returns int language plpgsql stable set search_path = public as $$
declare
  total int := 0; d date; dow int; entry jsonb;
  win_open timestamptz; win_close timestamptz; seg_start timestamptz; seg_end timestamptz;
begin
  if p_end <= p_start then return 0; end if;
  -- sem janela definida: comporta como 24/7 (diferença bruta)
  if p_schedule is null or jsonb_array_length(p_schedule) = 0 then
    return ceil(extract(epoch from (p_end - p_start)))::int;
  end if;
  -- itera cada dia (no fuso) tocado pelo intervalo
  d := (p_start at time zone p_tz)::date;
  while d <= (p_end at time zone p_tz)::date loop
    dow := extract(dow from d)::int;  -- 0=dom..6=sáb
    select e into entry from jsonb_array_elements(p_schedule) e
      where (e->>'dow')::int = dow and coalesce((e->>'enabled')::bool, false)
      limit 1;
    if entry is not null then
      -- interpreta HH:MM do dia no fuso da conexão
      win_open  := (d::text || ' ' || (entry->>'open'))::timestamp at time zone p_tz;
      win_close := (d::text || ' ' || (entry->>'close'))::timestamp at time zone p_tz;
      -- clipa a janela do dia ao intervalo [p_start, p_end]
      seg_start := greatest(win_open, p_start);
      seg_end   := least(win_close, p_end);
      if seg_end > seg_start then
        total := total + ceil(extract(epoch from (seg_end - seg_start)))::int;
      end if;
    end if;
    d := d + 1;
  end loop;
  return total;
end;
$$;
