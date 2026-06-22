-- ============================================================
-- 032 — Integração "Info Aluno" (Millaborges).
-- Key da plataforma de alunos na config existente (criptografada app-side)
-- + snapshot do panorama do aluno por contato (atualizado a cada abertura;
-- serve de fallback quando a API externa falha). Idempotente.
-- ============================================================

-- key da Millaborges na config de integrações (criptografada na rota, como os outros tokens)
ALTER TABLE integrations_config ADD COLUMN IF NOT EXISTS millaborges_api_key TEXT;

-- snapshot do panorama do aluno por contato
CREATE TABLE IF NOT EXISTS student_info (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL,            -- success | nao_encontrado | multiplos
  matched_by TEXT,                 -- email | cpf | telefone | null
  payload JSONB,                   -- resposta crua (aluno/cursos/redacoes/progresso) ou {candidatos}
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_id, contact_id)
);
CREATE INDEX IF NOT EXISTS idx_student_info_contact ON student_info(contact_id);

ALTER TABLE student_info ENABLE ROW LEVEL SECURITY;
-- leitura por qualquer membro da conta; escrita só via service-role (a rota) → fail-closed.
DROP POLICY IF EXISTS student_info_select ON student_info;
CREATE POLICY student_info_select ON student_info FOR SELECT
  USING (is_account_member(account_id));
