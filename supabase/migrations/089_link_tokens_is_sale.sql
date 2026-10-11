-- ============================================================
-- 089_link_tokens_is_sale.sql — link de venda marcado no token.
--
-- O token rastreável do agente de IA e do atendente passa a carregar se o
-- destino é link de venda. A marca é decidida no ENVIO e copiada para
-- link_clicks.is_sale no clique, que é o que o Lead Score pesa em dobro.
--
-- Fica no token (e não é recalculada no clique) porque ai_courses.link_venda
-- é zerado quando a matrícula do curso encerra: o link continua sendo de
-- venda para quem o recebeu enquanto estava aberto.
--
-- Link de flow não usa esta coluna: a marca dele vem do nó
-- wait_for_link_click.
--
-- Idempotente — pode rodar mais de uma vez.
-- ============================================================

ALTER TABLE link_tokens ADD COLUMN IF NOT EXISTS is_sale BOOLEAN NOT NULL DEFAULT false;

-- Tokens de agente/atendente ainda válidos passam a carregar a marca, para o
-- clique em link já enviado contar como venda. Mesma regra do envio
-- (src/lib/link-tracking/sale-link.ts): checkout da Hotmart ou link de
-- matrícula de curso da conta. O link de curso é comparado com o cadastro
-- atual, então o de curso já encerrado (link_venda zerado) só entra se for
-- checkout da Hotmart.
UPDATE link_tokens lt
   SET is_sale = true
 WHERE lt.is_sale = false
   AND lt.source IN ('agent', 'manual')
   AND lt.expires_at > now()
   AND (lt.url ILIKE 'https://pay.hotmart.com/%'
        OR EXISTS (SELECT 1 FROM ai_courses c
                    WHERE c.account_id = lt.account_id
                      AND c.link_venda IS NOT NULL
                      AND rtrim(btrim(c.link_venda), '/') = rtrim(btrim(lt.url), '/')));
