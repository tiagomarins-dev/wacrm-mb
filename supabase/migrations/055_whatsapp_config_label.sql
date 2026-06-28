-- ============================================================
-- 055 — Rótulo (apelido) customizável por conexão WhatsApp.
-- Permite ao admin nomear as conexões (ex.: "Vendas", "Suporte").
-- Exibido no seletor de conexão ativa e nos cards ANTES do
-- phone_number_id (fallback via helper connectionLabel). Sem backfill:
-- NULL cai no fallback. RLS inalterada (coluna TEXT não-sensível;
-- whatsapp_config já é account-scoped via is_account_member).
-- Idempotente: IF NOT EXISTS.
-- ============================================================
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS label TEXT;
