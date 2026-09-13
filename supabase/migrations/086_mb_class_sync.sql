-- ============================================================
-- 086_mb_class_sync.sql — de→para curso da Plataforma MB × tag do CRM.
-- mb_class_sync: pares cadastrados pelo admin na tela Turmas MB. Um curso pode
--   alimentar várias tags e uma tag pode receber vários cursos (união).
-- mb_class_sync_runs: log append-only do cron horário (/api/mb-sync/cron);
--   também é a base da guarda anti-remoção em massa (último run válido).
-- Espelha 051_sales_attribution.sql (mb_paid_courses + sales_cron_runs).
-- ============================================================
create table if not exists mb_class_sync (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  mb_course_id integer not null,
  mb_course_name text,                  -- cópia do nome p/ exibir sem consultar o MySQL
  tag_id uuid not null references tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (account_id, mb_course_id, tag_id)
);
create index if not exists idx_mb_class_sync_tag on mb_class_sync(tag_id);
alter table mb_class_sync enable row level security;
drop policy if exists mb_class_sync_read on mb_class_sync;
create policy mb_class_sync_read on mb_class_sync for select using (is_account_member(account_id));
drop policy if exists mb_class_sync_write on mb_class_sync;
create policy mb_class_sync_write on mb_class_sync for all
  using (is_account_member(account_id, 'admin')) with check (is_account_member(account_id, 'admin'));

-- Um registro por tag por execução (inclusive abortadas). Só o worker (service-role) escreve.
create table if not exists mb_class_sync_runs (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  tag_id uuid not null references tags(id) on delete cascade,
  course_ids integer[] not null default '{}',   -- conjunto ordenado de cursos da tag nesta execução
  students integer not null default 0,          -- alunos elegíveis (união, já sem equipe/opt-out)
  added integer not null default 0,
  removed integer not null default 0,
  created integer not null default 0,
  skipped integer not null default 0,           -- telefone inválido na plataforma
  aborted_reason text,                          -- null = run aplicado; senão o motivo
  ran_at timestamptz not null default now()
);
create index if not exists idx_mb_class_sync_runs_tag on mb_class_sync_runs(tag_id, ran_at desc);
alter table mb_class_sync_runs enable row level security;
drop policy if exists mb_class_sync_runs_read on mb_class_sync_runs;
create policy mb_class_sync_runs_read on mb_class_sync_runs for select using (is_account_member(account_id, 'admin'));
