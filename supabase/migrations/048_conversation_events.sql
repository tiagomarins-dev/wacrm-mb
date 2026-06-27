-- ============================================================
-- 048_conversation_events.sql — trilha interna de transferências de conversa.
-- 1 linha por mudança de assigned_agent_id em conversations (gravada por TRIGGER
-- — cobre UI/IA/cron/automação/fluxo num ponto só). Aparece na thread como evento
-- interno; NUNCA enviado ao cliente (tabela separada de messages, fora do meta-send).
-- Imutável; membros da conta leem; ninguém escreve via client (trigger SECURITY
-- DEFINER). Espelha 042_ai_agent_runs.sql.
-- ============================================================
create table if not exists conversation_events (
  id uuid primary key default uuid_generate_v4(),
  account_id uuid not null references accounts(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  type text not null check (type in ('assigned','transferred','unassigned')),
  from_agent_id uuid,         -- responsável anterior (humano user_id / ai_profile.id / AI_AGENT_USER_ID / null) — sem FK (igual conversations.assigned_agent_id)
  to_agent_id uuid,           -- novo responsável (idem; null = desatribuída)
  actor_user_id uuid,         -- auth.uid() de quem fez; null = sistema (cron/IA/automação via service-role)
  created_at timestamptz not null default now()
);
create index if not exists idx_conversation_events_conv_created on conversation_events (conversation_id, created_at);
alter table conversation_events enable row level security;
drop policy if exists conversation_events_read on conversation_events;
-- Leitura MEMBER-level (não admin como 042): todos os atendentes da conta veem os
-- eventos na thread. Sem policy de write — só o trigger escreve.
create policy conversation_events_read on conversation_events for select
  using (is_account_member(account_id));

-- Grava o evento quando assigned_agent_id muda. SECURITY DEFINER p/ inserir na
-- tabela RLS; auth.uid() segue retornando o usuário da sessão (null em service-role).
create or replace function log_conversation_assignment_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_agent_id is distinct from old.assigned_agent_id then
    insert into conversation_events (account_id, conversation_id, type, from_agent_id, to_agent_id, actor_user_id)
    values (
      new.account_id, new.id,
      case
        when new.assigned_agent_id is null then 'unassigned'
        when old.assigned_agent_id is null then 'assigned'
        else 'transferred'
      end,
      old.assigned_agent_id, new.assigned_agent_id, auth.uid()
    );
  end if;
  return new;
end;
$$;
drop trigger if exists trg_log_conversation_assignment on conversations;
create trigger trg_log_conversation_assignment
  after update of assigned_agent_id on conversations
  for each row execute function log_conversation_assignment_change();

-- Habilita realtime (postgres_changes INSERT) p/ a thread. Sem isto a subscription
-- conecta mas nunca recebe (espelha message_reactions, 009:106-114).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'conversation_events'
  ) then
    alter publication supabase_realtime add table conversation_events;
  end if;
end $$;
