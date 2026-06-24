-- ============================================================
-- 038_ai_agent_allowlist.sql — Allowlist de telefones (MODO TESTE).
-- Quando `allowed_phones` está preenchida, o agente SÓ responde a contatos
-- cujo telefone casa com a lista (igualdade ou sufixo de dígitos — tolera o
-- prefixo de país 55). Lista NULL/vazia = modo normal (responde a todos).
-- Trava de segurança p/ lançar o agente restrito a 1 número de teste.
-- ============================================================
ALTER TABLE ai_agent_config ADD COLUMN IF NOT EXISTS allowed_phones TEXT[];
