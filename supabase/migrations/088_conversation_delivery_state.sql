-- ============================================================
-- 088_conversation_delivery_state.sql — estado de entrega da última mensagem
-- NOSSA em cada conversa.
--
-- Denormaliza em conversations qual foi a última mensagem enviada por atendente
-- ou bot, quando saiu e se foi entregue, para a UI sinalizar, sem JOIN, o
-- contato que não está recebendo (ícone nas listas + faixa na conversa).
--
-- Trigger em messages (INSERT e UPDATE de status): cobre envio pela tela,
-- automações, flows e agente de IA sem tocar em nenhum write-point.
--
-- O estado é GROSSO de propósito (pending / delivered / failed): o recibo de
-- leitura e o recibo repetido não geram escrita em conversations, e por isso não
-- mexem em updated_at, que a desatribuição automática (045) usa como "conversa
-- parada". As únicas escritas vindas de recibo são pending -> delivered e
-- pending -> failed (e failed -> delivered, quando um reenvio é aceito).
--
-- last_outbound_state NULL = sem entrega a acompanhar. Acontece quando:
--   - a conexão não devolve confirmação de entrega (hoje, toda conexão que não
--     é Meta); as outras duas colunas ficam preenchidas mesmo assim;
--   - a conversa nunca teve mensagem nossa, ou estava finalizada no backfill
--     (as três colunas ficam NULL até a próxima mensagem nossa).
-- Em nenhum desses casos há alerta.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_outbound_message_id UUID,
  ADD COLUMN IF NOT EXISTS last_outbound_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_outbound_state TEXT
    CHECK (last_outbound_state IN ('pending', 'delivered', 'failed'));

-- Mapeia messages.status para o estado grosso de entrega. Leitura conta como
-- entregue; 'sending' e 'sent' contam como pendente.
CREATE OR REPLACE FUNCTION public.delivery_state_of(p_status TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status
    WHEN 'failed' THEN 'failed'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'read' THEN 'delivered'
    ELSE 'pending'
  END
$$;

-- O trigger roda com o papel de quem grava a mensagem: authenticated no envio
-- pela tela, service_role no webhook e nos workers. O GRANT é explícito para
-- não depender dos privilégios padrão do ambiente; sem ele o INSERT da
-- mensagem falharia com "permission denied" dentro do trigger.
REVOKE ALL ON FUNCTION public.delivery_state_of(TEXT) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delivery_state_of(TEXT) TO authenticated, service_role;

-- Mantém na conversa a última mensagem nossa e o estado de entrega dela.
CREATE OR REPLACE FUNCTION public.track_conversation_delivery()
RETURNS TRIGGER AS $$
DECLARE
  v_state TEXT := public.delivery_state_of(NEW.status);
BEGIN
  -- Só mensagens nossas entram: a do cliente não tem entrega a acompanhar.
  IF NEW.sender_type NOT IN ('agent', 'bot') THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A mensagem vira "a última nossa" se for mais nova que a registrada.
    -- Mensagem antiga inserida depois (sincronização de histórico) não entra.
    UPDATE conversations c
       SET last_outbound_message_id = NEW.id,
           last_outbound_at = NEW.created_at,
           last_outbound_state = CASE
             WHEN EXISTS (SELECT 1 FROM whatsapp_config w
                           WHERE w.id = c.connection_id
                             AND w.account_id = c.account_id
                             AND w.provider = 'meta')
             THEN v_state END
     WHERE c.id = NEW.conversation_id
       AND (c.last_outbound_at IS NULL OR NEW.created_at >= c.last_outbound_at);
  ELSE
    -- Recibo: só o da última mensagem nossa e só quando o estado grosso avança.
    -- Nunca volta para pending (recibo fora de ordem) e nunca sai de delivered:
    -- "failed" depois de entregue é recibo atrasado ou inválido, mesma regra que
    -- o webhook aplica aos destinatários de disparo (isValidStatusTransition).
    UPDATE conversations c
       SET last_outbound_state = v_state
     WHERE c.id = NEW.conversation_id
       AND c.last_outbound_message_id = NEW.id
       AND c.last_outbound_state IS NOT NULL
       AND v_state <> 'pending'
       AND c.last_outbound_state <> 'delivered'
       AND c.last_outbound_state IS DISTINCT FROM v_state;
  END IF;
  RETURN NULL;  -- AFTER trigger: retorno é ignorado
END;
$$ LANGUAGE plpgsql SET search_path = public;

DROP TRIGGER IF EXISTS track_conversation_delivery_ins ON messages;
CREATE TRIGGER track_conversation_delivery_ins
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION public.track_conversation_delivery();

DROP TRIGGER IF EXISTS track_conversation_delivery_upd ON messages;
CREATE TRIGGER track_conversation_delivery_upd
  AFTER UPDATE OF status ON messages
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.track_conversation_delivery();

-- Backfill das conversas não finalizadas sem mexer em updated_at (a
-- desatribuição automática usa essa data como "parada"). Bloco único: se algo
-- falhar, o DISABLE é desfeito junto e o trigger set_updated_at continua ligado.
-- A última mensagem nossa de cada conversa é calculada ANTES de desligar o
-- trigger: o DISABLE trava a escrita em conversations até o fim do bloco, então
-- a leitura de messages fica fora dessa janela e a trava dura só o UPDATE.
DO $$
BEGIN
  CREATE TEMP TABLE tmp_088_last_outbound ON COMMIT DROP AS
    SELECT DISTINCT ON (mm.conversation_id)
           mm.conversation_id, mm.id, mm.created_at, mm.status
      FROM messages mm
      JOIN conversations c ON c.id = mm.conversation_id
     WHERE mm.sender_type IN ('agent', 'bot')
       AND c.status <> 'closed'
       AND c.last_outbound_message_id IS NULL
     ORDER BY mm.conversation_id, mm.created_at DESC, mm.id DESC;

  PERFORM set_config('lock_timeout', '5s', true);
  ALTER TABLE conversations DISABLE TRIGGER set_updated_at;
  UPDATE conversations c
     SET last_outbound_message_id = m.id,
         last_outbound_at = m.created_at,
         last_outbound_state = CASE WHEN w.provider = 'meta'
                                    THEN public.delivery_state_of(m.status) END
    FROM tmp_088_last_outbound m, whatsapp_config w
   WHERE m.conversation_id = c.id
     AND w.id = c.connection_id
     AND w.account_id = c.account_id
     AND c.status <> 'closed'
     AND c.last_outbound_message_id IS NULL;
  ALTER TABLE conversations ENABLE TRIGGER set_updated_at;
END $$;
