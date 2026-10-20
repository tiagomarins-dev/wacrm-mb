-- ============================================================
-- 092_message_delivery_error.sql — motivo da falha de entrega por mensagem.
--
-- Quando a Meta devolve status 'failed', o recibo traz errors[] com código,
-- título e detalhe. O webhook grava esse motivo na própria mensagem para a
-- conversa mostrar ao atendente por que o contato não recebeu (template de
-- marketing limitado, número sem WhatsApp, janela de 24 h fechada...).
--
-- error_code: código numérico da Meta (ex.: 131049), para agrupar por causa.
-- error_message: código, título e detalhe concatenados, até 500 caracteres
--   (mesmo formato de broadcast_recipients.error_message).
-- As duas ficam NULL em toda mensagem que não falhou.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code INTEGER,
  ADD COLUMN IF NOT EXISTS error_message TEXT;
