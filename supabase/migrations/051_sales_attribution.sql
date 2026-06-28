-- ============================================================
-- 051_sales_attribution.sql — atribuição de venda (matrícula MB) por atendente.
-- atendente_id é USER_ID (auth.uid()), nunca profile id nem id de IA.
-- attributed_sales: fato append-only escrito SÓ pelo worker (service-role); read member.
-- Espelha 042_ai_agent_runs.sql (fato sem write policy) e business_hours (049, RLS admin).
-- ============================================================
create table if not exists mb_paid_courses (
  account_id uuid not null references accounts(id) on delete cascade,
  id_curso integer not null,
  nome_curso text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (account_id, id_curso)
);
alter table mb_paid_courses enable row level security;
drop policy if exists mb_paid_courses_read on mb_paid_courses;
create policy mb_paid_courses_read on mb_paid_courses for select using (is_account_member(account_id));
drop policy if exists mb_paid_courses_write on mb_paid_courses;
create policy mb_paid_courses_write on mb_paid_courses for all
  using (is_account_member(account_id, 'admin')) with check (is_account_member(account_id, 'admin'));

create table if not exists attributed_sales (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  connection_id uuid,                -- copiado de conversations.connection_id (filtro da RPC)
  atendente_id uuid,                 -- USER_ID do humano; null = sem humano (não contado)
  id_curso integer not null,
  nome_curso text,
  data_matricula date not null,
  sale_type text,                    -- 'ativa'|'passiva'|null (Fase 3)
  confidence text not null default 'high',  -- high (ai_topic=vendas) | low
  status text not null default 'confirmed', -- confirmed | reverted
  created_at timestamptz not null default now(),
  unique(account_id, conversation_id, id_curso)
);
create index if not exists idx_attributed_sales_acct on attributed_sales(account_id, created_at desc);
create index if not exists idx_attributed_sales_agent on attributed_sales(account_id, atendente_id, data_matricula);
create index if not exists idx_attributed_sales_revert on attributed_sales(account_id, status, data_matricula);
alter table attributed_sales enable row level security;
drop policy if exists attributed_sales_read on attributed_sales;
create policy attributed_sales_read on attributed_sales for select using (is_account_member(account_id));
-- sem write policy: só o worker (service-role) escreve.

-- janela de atribuição por conta (default 30d). Diverge do escopo por-conexão das
-- outras features (aceito v1).
alter table integrations_config add column if not exists mb_attribution_window_days int not null default 30;

-- saúde do worker: no-op temporal (1x/dia) + match rate. Append; admin lê (paridade 042).
create table if not exists sales_cron_runs (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid references accounts(id) on delete cascade,
  contacts_checked int not null default 0,
  matched int not null default 0,
  sales_inserted int not null default 0,
  reverted int not null default 0,
  ran_at timestamptz not null default now()
);
alter table sales_cron_runs enable row level security;
drop policy if exists sales_cron_runs_read on sales_cron_runs;
create policy sales_cron_runs_read on sales_cron_runs for select using (is_account_member(account_id, 'admin'));
