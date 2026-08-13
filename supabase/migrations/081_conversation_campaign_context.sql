-- ============================================================
-- 081_conversation_campaign_context.sql — Contexto da campanha por conversa.
--
-- No fluxo ATIVO (template com botão -> automação -> passo "Responder com IA"), a
-- agente não sabia qual era a ação alvo nem o que o template prometeu: esse contexto
-- só existia hardcoded no opening_prompt do PERFIL, o que obrigava a clonar um perfil
-- de IA por campanha. Agora o passo ai_reply grava aqui o texto configurado na
-- automação e o engine do agente LÊ desta coluna a cada run — mesmo padrão do
-- lead_context (lido do banco, não carregado na fila).
--
-- Precisa ser coluna, e não campo da fila: o caminho do cron (ai_agent_pending, 037)
-- não tem campo livre, então sem isto o contexto morreria depois da 1ª resposta.
--
-- campaign_context_at é a base do TTL aplicado no engine: conversa reaberta meses
-- depois não pode receber oferta de campanha encerrada. Sem índice: a coluna nunca é
-- filtro, só é lida junto do id da conversa (PK). RLS não muda — conversations já tem
-- policy por linha (017_account_sharing.sql) e coluna nova herda a policy da tabela.
--
-- Idempotente — safe to run multiple times.
-- ============================================================

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS campaign_context TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS campaign_context_at TIMESTAMPTZ;
