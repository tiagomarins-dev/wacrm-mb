-- ============================================================
-- 040_ai_profiles.sql — Perfis de IA (múltiplos agentes atribuíveis).
-- Cada perfil é um "responsável" virtual: ai_profiles.id = conversations.
-- assigned_agent_id (coluna SEM FK — 001:145). Atribuir a conversa a um perfil
-- = o bot atua com a config DELE. Roteamento sai do LLM → vai pra atribuição.
--
-- RLS: a base é TODA admin (persona_prompt é sensível — anti prompt-injection,
-- mesmo racional de AiAgentConfigPublic). Membros (dropdowns) leem só
-- id/nome/enabled pela VIEW ai_profiles_public. Molde policies-por-comando:
-- 026_quick_replies.sql:40-78. Trigger: update_updated_at_column (001:344).
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  slug TEXT,                                  -- cosmético no v1 (sem UNIQUE)
  enabled BOOLEAN NOT NULL DEFAULT true,
  persona_prompt TEXT,                        -- sensível → só admin lê (base)
  model TEXT NOT NULL DEFAULT 'openai/gpt-4o-mini',
  classifier_model TEXT,
  max_bot_turns INTEGER NOT NULL DEFAULT 8,
  handoff_routing JSONB,                      -- {"vendas":"<user_id>","suporte":"..."}
  allowed_tools TEXT[],                       -- null = todas as tools de domínio
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_profiles_account ON ai_profiles(account_id) WHERE enabled;

ALTER TABLE ai_profiles ENABLE ROW LEVEL SECURITY;
-- Base = admin em TODOS os comandos (SELECT inclusive → persona não vaza).
DROP POLICY IF EXISTS ai_profiles_select ON ai_profiles;
CREATE POLICY ai_profiles_select ON ai_profiles FOR SELECT USING (is_account_member(account_id,'admin'));
DROP POLICY IF EXISTS ai_profiles_insert ON ai_profiles;
CREATE POLICY ai_profiles_insert ON ai_profiles FOR INSERT WITH CHECK (is_account_member(account_id,'admin'));
DROP POLICY IF EXISTS ai_profiles_update ON ai_profiles;
CREATE POLICY ai_profiles_update ON ai_profiles FOR UPDATE
  USING (is_account_member(account_id,'admin')) WITH CHECK (is_account_member(account_id,'admin'));
DROP POLICY IF EXISTS ai_profiles_delete ON ai_profiles;
CREATE POLICY ai_profiles_delete ON ai_profiles FOR DELETE USING (is_account_member(account_id,'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON ai_profiles;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- VIEW pública: qualquer MEMBRO lê só id/nome/enabled (dropdowns do inbox/builder).
-- security_invoker=off (roda como owner → contorna a RLS admin da base) +
-- WHERE is_account_member(account_id) como tenant gate. is_account_member é
-- SECURITY DEFINER usando auth.uid() (017:136) → resolve o usuário chamador.
DROP VIEW IF EXISTS ai_profiles_public;
CREATE VIEW ai_profiles_public WITH (security_invoker = off) AS
  SELECT id, account_id, nome, enabled FROM ai_profiles WHERE is_account_member(account_id);
GRANT SELECT ON ai_profiles_public TO authenticated;

-- Seed do perfil DEFAULT (compat). id = AI_AGENT_USER_ID (a constante atual).
-- Como id é PK, a constante só pode pertencer a 1 conta → seedar SÓ a conta que
-- JÁ tem conversa atribuída à constante (a de teste). Demais contas sem default
-- (nunca tiveram bot → sem regressão). Determinístico: config da conexão mais
-- antiga por conta (DISTINCT ON ... ORDER BY created_at).
INSERT INTO ai_profiles (id, account_id, nome, model, persona_prompt, handoff_routing, max_bot_turns)
SELECT DISTINCT ON (cfg.account_id)
  '00000000-0000-0000-0000-0000000000a1'::uuid, cfg.account_id, 'Assistente',
  COALESCE(cfg.model, 'openai/gpt-4o-mini'), cfg.persona_prompt, cfg.handoff_routing,
  COALESCE(cfg.max_bot_turns, 8)
FROM ai_agent_config cfg
WHERE EXISTS (
  SELECT 1 FROM conversations c
  WHERE c.account_id = cfg.account_id
    AND c.assigned_agent_id = '00000000-0000-0000-0000-0000000000a1'::uuid
)
ORDER BY cfg.account_id, cfg.created_at
ON CONFLICT (id) DO NOTHING;
