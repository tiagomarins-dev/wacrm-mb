-- ============================================================
-- 053_reports_intelligence.sql — Fase 3 dos relatórios.
-- report_intent: intenção classificada por LLM (eleva confidence da Fase 2).
-- override: auditoria de cancelamento/reatribuição de venda pelo admin.
-- intent_cron_runs: saúde/custo do classificador. NÃO recria sale_type (051:32).
-- ============================================================
alter table conversations add column if not exists report_intent text;        -- 'vendas'|'suporte'|'outro'
alter table conversations add column if not exists report_intent_at timestamptz;

alter table attributed_sales add column if not exists overridden_by uuid;
alter table attributed_sales add column if not exists override_reason text;
alter table attributed_sales add column if not exists overridden_at timestamptz;

-- varredura do classificador (pendentes) sem full-scan
create index if not exists idx_conversations_intent_pending
  on conversations(account_id, last_message_at) where report_intent is null;

-- saúde/custo do classificador (espelha sales_cron_runs 051:51; admin lê)
create table if not exists intent_cron_runs (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid references accounts(id) on delete cascade,
  classified int not null default 0,
  errors int not null default 0,
  tokens int not null default 0,
  ran_at timestamptz not null default now()
);
alter table intent_cron_runs enable row level security;
drop policy if exists intent_cron_runs_read on intent_cron_runs;
create policy intent_cron_runs_read on intent_cron_runs for select using (is_account_member(account_id, 'admin'));
