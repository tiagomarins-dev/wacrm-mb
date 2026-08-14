-- 082_ai_cost_reports.sql
-- Relatório de custo do agente de IA: resumo agregado + uma linha por conversa.
-- ai_agent_runs guarda UMA run por mensagem respondida (telemetria do runAgentLoop);
-- o relatório soma essas runs por conversa para responder "quanto custou atender
-- esta pessoa". SECURITY DEFINER porque a RLS de ai_agent_runs só libera leitura
-- pela service role — o escopo à conta é feito aqui dentro, no account_id do caller.
-- admin+ apenas (custo é dado financeiro): agent/viewer recebem vazio.

-- Drop antes do create: Postgres recusa trocar as colunas de retorno de uma
-- função existente, e sem isso reaplicar a migration falha num banco que já a rodou.
drop function if exists ai_cost_summary(int, uuid);
drop function if exists ai_cost_by_conversation(int, uuid);

-- Cards do topo: totais do período. Uma linha só, para não fazer o front somar
-- a tabela paginada (que tem teto de 500 linhas e mentiria no total).
create or replace function ai_cost_summary(
  p_window_days int default 30,
  p_connection_id uuid default null
) returns table(
  custo_usd numeric, conversas bigint, runs bigint, chamadas_llm bigint,
  tokens bigint, custo_medio_conversa numeric, handoffs bigint,
  erros bigint, sem_resposta bigint
) language plpgsql stable security definer set search_path = public as $$
declare acc uuid; ini timestamptz;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc, 'admin') then return; end if;
  ini := now() - make_interval(days => greatest(p_window_days, 1));

  return query
  select
    coalesce(sum(r.cost_usd), 0)::numeric,
    count(distinct r.conversation_id)::bigint,
    count(*)::bigint,
    coalesce(sum(r.requests), 0)::bigint,
    coalesce(sum(r.total_tokens), 0)::bigint,
    -- Média POR CONVERSA (não por run): é o número que responde "quanto me custa
    -- um atendimento". nullif evita divisão por zero em período sem tráfego.
    (coalesce(sum(r.cost_usd), 0) / nullif(count(distinct r.conversation_id), 0))::numeric,
    count(*) filter (where r.handoff)::bigint,
    -- 'error' é falha de verdade (LLM caiu ou envio falhou). 'no_reply' é a IA
    -- rodando e decidindo não responder — separado, senão o card acusa problema
    -- onde o comportamento foi o esperado.
    count(*) filter (where r.status = 'error')::bigint,
    count(*) filter (where r.status = 'no_reply')::bigint
  from ai_agent_runs r
  where r.account_id = acc
    and r.created_at >= ini
    and (p_connection_id is null or r.connection_id = p_connection_id);
end $$;

-- Tabela: uma linha por conversa, da mais cara para a mais barata. Traz o nome do
-- contato para a linha ser clicável até /inbox?c=<conversation_id>.
create or replace function ai_cost_by_conversation(
  p_window_days int default 30,
  p_connection_id uuid default null
) returns table(
  conversation_id uuid, contact_id uuid, contact_name text, contact_phone text,
  custo_usd numeric, runs bigint, chamadas_llm bigint, tokens bigint,
  handoffs bigint, erros bigint, modelos text[], ultima_run timestamptz
) language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare acc uuid; ini timestamptz;
begin
  select account_id into acc from profiles where user_id = auth.uid();
  if acc is null or not is_account_member(acc, 'admin') then return; end if;
  ini := now() - make_interval(days => greatest(p_window_days, 1));

  return query
  with por_conversa as (
    select r.conversation_id as cv,
           sum(r.cost_usd) as custo,
           count(*) as runs,
           sum(r.requests) as chamadas,
           sum(r.total_tokens) as tokens,
           count(*) filter (where r.handoff) as handoffs,
           count(*) filter (where r.status = 'error') as erros,
           array_agg(distinct r.model) filter (where r.model is not null) as modelos,
           max(r.created_at) as ultima
    from ai_agent_runs r
    where r.account_id = acc
      and r.created_at >= ini
      and r.conversation_id is not null
      and (p_connection_id is null or r.connection_id = p_connection_id)
    group by r.conversation_id
  )
  select p.cv, c.contact_id, ct.name, ct.phone,
         coalesce(p.custo, 0)::numeric, p.runs, coalesce(p.chamadas, 0)::bigint,
         coalesce(p.tokens, 0)::bigint, p.handoffs, p.erros, p.modelos, p.ultima
  from por_conversa p
  -- inner join: conversa apagada sai do relatório (não há o que abrir no clique).
  join conversations c on c.id = p.cv
  left join contacts ct on ct.id = c.contact_id
  order by coalesce(p.custo, 0) desc, p.ultima desc
  limit 500;  -- teto defensivo; os cards trazem o total real do período
end $$;

grant execute on function ai_cost_summary(int, uuid) to authenticated;
revoke execute on function ai_cost_summary(int, uuid) from anon;
grant execute on function ai_cost_by_conversation(int, uuid) to authenticated;
revoke execute on function ai_cost_by_conversation(int, uuid) from anon;
