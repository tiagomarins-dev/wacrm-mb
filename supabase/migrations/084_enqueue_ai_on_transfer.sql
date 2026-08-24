-- Transferir uma conversa para o agente de IA coloca a conversa na fila de
-- respostas (ai_agent_pending) quando há mensagem do cliente sem resposta.
--
-- A fila normalmente é alimentada só pelo webhook de mensagem recebida; sem
-- isto, uma conversa transferida para a IA com pergunta pendente ficaria muda
-- até o cliente mandar OUTRA mensagem. O trigger é o único ponto que enxerga
-- toda transferência, porque a atribuição é um UPDATE direto do navegador via
-- RLS (não passa por rota de API) — mesmo motivo do trg_log_conversation_assignment.

create or replace function enqueue_ai_agent_on_transfer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_last_msg record;
begin
  -- Só interessa a chegada NO agente de IA; sair dele ou trocar entre humanos não
  -- enfileira. "Agente de IA" é o bot genérico OU um perfil de IA (a UI grava os
  -- dois tipos de id em assigned_agent_id — ver resolveAssignee em src/lib/inbox).
  if new.assigned_agent_id is null
     or old.assigned_agent_id is not distinct from new.assigned_agent_id then
    return new;
  end if;
  if new.assigned_agent_id <> '00000000-0000-0000-0000-0000000000a1'::uuid
     and not exists (select 1 from ai_profiles ap where ap.id = new.assigned_agent_id) then
    return new;
  end if;

  -- Conversa fechada não recebe resposta automática; grupo (sem contato) não é
  -- atendido pelo agente.
  if new.status <> 'open' or new.contact_id is null then
    return new;
  end if;

  -- Só enfileira se a ÚLTIMA mensagem é do cliente: há algo a responder. Se o
  -- último a falar foi a equipe (ou não há mensagens), a IA espera o cliente,
  -- em vez de se apresentar do nada numa conversa parada.
  select m.id, m.sender_type into v_last_msg
  from messages m
  where m.conversation_id = new.id
  order by m.created_at desc
  limit 1;

  if v_last_msg.id is null or v_last_msg.sender_type <> 'customer' then
    return new;
  end if;

  -- Dedupe: já na fila ou em processamento → não duplica o run.
  insert into ai_agent_pending
    (account_id, connection_id, conversation_id, contact_id, run_at, status, last_inbound_message_id, attempts)
  select new.account_id, new.connection_id, new.id, new.contact_id, now(), 'pending', v_last_msg.id::text, 0
  where not exists (
    select 1 from ai_agent_pending p
    where p.conversation_id = new.id and p.status in ('pending', 'running')
  );

  return new;
end;
$$;

drop trigger if exists trg_enqueue_ai_on_transfer on conversations;
create trigger trg_enqueue_ai_on_transfer
  after update of assigned_agent_id on conversations
  for each row execute function enqueue_ai_agent_on_transfer();
