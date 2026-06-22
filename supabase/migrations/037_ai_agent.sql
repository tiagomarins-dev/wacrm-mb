-- ============================================================
-- 037_ai_agent.sql — Agente de IA no WhatsApp (vendas + suporte) v1.
-- Espelha o padrão de 031_lead_score.sql / 032_student_info.sql:
--   uuid_generate_v4(), RLS is_account_member(account_id,'admin'),
--   trigger update_updated_at_column(), idempotência IF NOT EXISTS.
-- Extensão uuid-ossp já habilitada em 001_initial_schema.sql:8.
-- Funções is_account_member (017:136) e update_updated_at_column (001:344) já existem.
-- ============================================================

-- ----- Config do agente por conexão (multi-número, 033). 1 row por conexão.
CREATE TABLE IF NOT EXISTS ai_agent_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,           -- liga/desliga por número
  debounce_seconds INTEGER NOT NULL DEFAULT 12,     -- janela de silêncio antes de responder
  -- modelo do agente: INDEPENDENTE do integrations_config.openrouter_model (que é só p/ resumos)
  model TEXT NOT NULL DEFAULT 'openai/gpt-4o-mini',
  classifier_model TEXT,                            -- 2º modelo barato p/ pré-classificação (null = usa model)
  persona_prompt TEXT,                              -- prompt-base editável (guardrails injetados DEPOIS)
  handoff_hours JSONB,                              -- horário comercial p/ handoff
  handoff_routing JSONB,                            -- {"vendas":"<user_id>","suporte":"<user_id>"}
  max_bot_turns INTEGER NOT NULL DEFAULT 8,         -- trava anti-loop por conversa
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(connection_id)
);
ALTER TABLE ai_agent_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_agent_config_rw ON ai_agent_config;
CREATE POLICY ai_agent_config_rw ON ai_agent_config FOR ALL
  USING (is_account_member(account_id,'admin')) WITH CHECK (is_account_member(account_id,'admin'));
DROP TRIGGER IF EXISTS set_updated_at ON ai_agent_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_agent_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ----- Fila de debounce. 1 row por conversa pendente. Escrita SÓ via service-role (cron/dispatch).
CREATE TABLE IF NOT EXISTS ai_agent_pending (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES whatsapp_config(id) ON DELETE RESTRICT,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  run_at TIMESTAMPTZ NOT NULL,                       -- now() + debounce_seconds (empurrado a cada msg)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','error')),
  last_inbound_message_id TEXT,                      -- wamid da Meta (texto, não uuid) — detectar msg nova durante o run
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(conversation_id)                            -- 1 pendência por conversa (upsert)
);
CREATE INDEX IF NOT EXISTS idx_ai_pending_due ON ai_agent_pending (run_at) WHERE status = 'pending';
-- Sem policy = fail-closed (só service-role escreve/lê), igual link_tokens (030).
ALTER TABLE ai_agent_pending ENABLE ROW LEVEL SECURITY;

-- ----- Base de VENDAS (cursos). Fonte: voz-milla/produtos.md. Editável no settings.
-- Seed NÃO vai aqui: cada row precisa de account_id (multi-tenant) → seeding é
-- por conta (via UI da Fase C ou SQL manual com o account_id real).
CREATE TABLE IF NOT EXISTS ai_courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,                                -- 'metodo-blindado-intensivo', 'mestres-uerj'
  nome TEXT NOT NULL,
  ativo BOOLEAN NOT NULL DEFAULT true,               -- soft-delete
  posicionamento TEXT,
  publico TEXT,
  entregas TEXT,
  numeros_claims TEXT,                               -- claims APROVADOS (7 nota 1000, 900+)
  condicao_vigente TEXT,                             -- preço/parcelamento/lote
  bonus TEXT,
  garantia TEXT,
  nao_prometer TEXT,                                 -- guardrail por curso
  pagina_vendas_url TEXT,
  link_venda TEXT,                                   -- checkout (Hotmart etc.)
  atualizado_em DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, slug)
);
ALTER TABLE ai_courses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_courses_rw ON ai_courses;
CREATE POLICY ai_courses_rw ON ai_courses FOR ALL
  USING (is_account_member(account_id,'admin')) WITH CHECK (is_account_member(account_id,'admin'));
DROP TRIGGER IF EXISTS set_updated_at ON ai_courses;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_courses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ----- Base de SUPORTE (FAQ/procedimentos). Fonte da tool buscar_suporte.
CREATE TABLE IF NOT EXISTS ai_support_articles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL,                           -- 'acesso','plataforma','financeiro','correcao','aulas'
  titulo TEXT NOT NULL,
  conteudo TEXT NOT NULL,                            -- resposta/procedimento
  keywords TEXT,                                     -- termos p/ match ilike no v1
  ativo BOOLEAN NOT NULL DEFAULT true,
  -- FUNDAÇÃO RAG (v1.5/v2): ativar pgvector e descomentar a coluna abaixo.
  -- embedding vector(1536),
  atualizado_em DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_account_cat ON ai_support_articles (account_id, categoria) WHERE ativo;
ALTER TABLE ai_support_articles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ai_support_rw ON ai_support_articles;
CREATE POLICY ai_support_rw ON ai_support_articles FOR ALL
  USING (is_account_member(account_id,'admin')) WITH CHECK (is_account_member(account_id,'admin'));
DROP TRIGGER IF EXISTS set_updated_at ON ai_support_articles;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ai_support_articles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ----- Opt-out (contato pediu pra não falar com bot) + assunto detectado.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS ai_opt_out BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS ai_topic TEXT;   -- 'vendas' | 'suporte' | null

-- ----- FUNDAÇÃO multimídia (v2): cache de transcrição/visão por mensagem. NÃO usada no v1.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_extracted_text TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_extracted_at TIMESTAMPTZ;

-- ----- (C1/P2) link_tokens p/ tokens do agente (sem flow_run).
-- flow_id não tem FK (030:13); run_id referencia flow_runs (FK aceita NULL).
ALTER TABLE link_tokens ALTER COLUMN flow_id DROP NOT NULL;
ALTER TABLE link_tokens ALTER COLUMN run_id  DROP NOT NULL;
ALTER TABLE link_tokens ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'flow';

-- ----- (C1) ampliar o CHECK de link_clicks.source p/ aceitar 'agent'.
-- CHECK inline (029:30) não é alterável → DROP + ADD. O nome abaixo é o default
-- do Postgres p/ CHECK de coluna (<tabela>_<coluna>_check); confirmar com \d se necessário.
ALTER TABLE link_clicks DROP CONSTRAINT IF EXISTS link_clicks_source_check;
ALTER TABLE link_clicks ADD CONSTRAINT link_clicks_source_check
  CHECK (source IN ('flow','broadcast','automation','manual','agent'));
