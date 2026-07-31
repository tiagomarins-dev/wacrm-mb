-- ============================================================
-- 079_ai_profile_opening_prompt.sql — Diretriz de abertura por perfil de IA.
-- A 1ª resposta do agente em modo abertura (passo ai_reply) segue uma diretriz
-- fixa (cumprimenta + pergunta aberta). Perfis de campanha precisam abrir
-- direto ao ponto (ex.: "tenho uma ótima notícia"), então a diretriz vira
-- configurável: opening_prompt preenchido substitui o texto padrão. As demais
-- proteções de abertura (sem handoff, sem tool de transferência) permanecem
-- no engine/tools e não são afetadas por esta coluna.
-- ============================================================
ALTER TABLE ai_profiles ADD COLUMN IF NOT EXISTS opening_prompt TEXT;
