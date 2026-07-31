-- ============================================================
-- 078_broadcast_ai_agent.sql — Broadcast com agente de IA (contato ativo).
-- ai_profile_id: perfil de IA vinculado à campanha; quando o lead responde ao
--   template, o webhook atribui a conversa a esse perfil (se sem responsável) e
--   o fluxo reativo existente (dispatch → engine) assume.
--   FK sem checagem de conta no INSERT: a defesa fica a jusante —
--   resolveAssignedProfile exige account_id + enabled (dispatch.ts:124-130);
--   perfil de outra conta nunca atua.
-- lead_context: respostas da pesquisa por destinatário (colunas extras do CSV),
--   injetadas no system prompt do agente.
-- Índice por contact_id: a atribuição (e o flag de reply) consultam recipients
--   por contato a CADA inbound; só existia índice por broadcast_id (001).
-- ============================================================
ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS ai_profile_id UUID REFERENCES ai_profiles(id) ON DELETE SET NULL;

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS lead_context JSONB;

CREATE INDEX IF NOT EXISTS idx_broadcast_recipients_contact
  ON broadcast_recipients(contact_id);
