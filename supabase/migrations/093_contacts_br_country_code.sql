-- ============================================================
-- 093_contacts_br_country_code.sql — acrescenta o 55 aos telefones
-- brasileiros gravados sem o código do país.
--
-- Contato criado à mão ou por planilha guardava o número como digitado
-- (ex.: "15991306578"). Sem o 55, o template de primeiro contato falha mais
-- na Meta. A regra é a mesma de addBrazilCountryCode (src/lib/whatsapp/
-- phone-utils.ts): só dígitos, DDD válido e
--   - 11 dígitos com o terceiro dígito 9 (celular), ou
--   - 10 dígitos com o terceiro dígito entre 2 e 9 (fixo/celular antigo).
--
-- O contato que já tem um gêmeo com 55 na mesma conexão fica de fora: o
-- índice único (account_id, connection_id, phone_normalized) impediria o
-- UPDATE, e juntar os dois exige repontar conversas — tratado à parte.
-- Também fica de fora quem já escreveu para nós: o telefone dele veio do
-- wa_id da Meta, já com o código do país, e um estrangeiro com formato de
-- brasileiro (celular do Peru 51 9xxxxxxxx) seria reescrito para outra pessoa.
--
-- Backup em contacts_bkp_pre_55 (id + telefone antigo) para desfazer:
--   UPDATE contacts c SET phone = b.phone FROM contacts_bkp_pre_55 b WHERE b.id = c.id;
--
-- Idempotente: o que a regra corrige deixa de ter 10/11 dígitos, e quem
-- ficou de fora continua de fora numa nova rodada.
-- ============================================================

CREATE TABLE IF NOT EXISTS contacts_bkp_pre_55 AS
  SELECT id, phone, now() AS salvo_em
    FROM contacts
   WHERE false;

-- Mesma regra nos dois passos: o backup guarda exatamente as linhas que o
-- UPDATE vai alterar.
WITH alvo AS (
  SELECT c.id, c.phone, regexp_replace(c.phone, '\D', '', 'g') AS dig
    FROM contacts c
   WHERE (
           (length(regexp_replace(c.phone, '\D', '', 'g')) = 11
            AND substr(regexp_replace(c.phone, '\D', '', 'g'), 3, 1) = '9')
        OR (length(regexp_replace(c.phone, '\D', '', 'g')) = 10
            AND substr(regexp_replace(c.phone, '\D', '', 'g'), 3, 1) BETWEEN '2' AND '9')
         )
     AND substr(regexp_replace(c.phone, '\D', '', 'g'), 1, 2) IN (
           '11','12','13','14','15','16','17','18','19','21','22','24','27','28',
           '31','32','33','34','35','37','38','41','42','43','44','45','46','47',
           '48','49','51','53','54','55','61','62','63','64','65','66','67','68',
           '69','71','73','74','75','77','79','81','82','83','84','85','86','87',
           '88','89','91','92','93','94','95','96','97','98','99')
     AND NOT EXISTS (
           SELECT 1 FROM contacts o
            WHERE o.account_id = c.account_id
              AND o.connection_id IS NOT DISTINCT FROM c.connection_id
              AND o.id <> c.id
              AND o.phone_normalized = '55' || regexp_replace(c.phone, '\D', '', 'g'))
     AND NOT EXISTS (
           SELECT 1 FROM conversations cv
             JOIN messages m ON m.conversation_id = cv.id
            WHERE cv.contact_id = c.id AND m.sender_type = 'customer')
),
bkp AS (
  INSERT INTO contacts_bkp_pre_55 (id, phone, salvo_em)
  SELECT id, phone, now() FROM alvo
  RETURNING id
)
UPDATE contacts c
   SET phone = '55' || alvo.dig
  FROM alvo
 WHERE c.id = alvo.id;

ALTER TABLE contacts_bkp_pre_55 ENABLE ROW LEVEL SECURITY;
