-- ============================================================
-- Status de conversa customizáveis por conta. As 3 linhas de SISTEMA
-- (open/pending/closed) mantêm as chaves acopladas a comportamento
-- (automations/engine.ts, flows/engine.ts, dashboard/queries.ts, auto-unassign);
-- as custom são só rótulo+cor (dropdown de troca, badge, filtro). RLS/schema
-- espelham conversation_notes (059): account_id + is_account_member.
-- Idempotente. Reverter = drop table + recriar o CHECK de conversations.status.
-- ============================================================
CREATE TABLE IF NOT EXISTS conversation_statuses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                -- estável; system: open/pending/closed; custom: slug
  label TEXT NOT NULL,
  color TEXT NOT NULL,              -- hex (#rrggbb)
  is_system BOOLEAN NOT NULL DEFAULT false,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, key)
);

CREATE INDEX IF NOT EXISTS idx_conv_statuses_account
  ON conversation_statuses(account_id);

ALTER TABLE conversation_statuses ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro. Escrita: admin+ (espelha 059, com role admin).
DROP POLICY IF EXISTS conv_statuses_select ON conversation_statuses;
CREATE POLICY conv_statuses_select ON conversation_statuses
  FOR SELECT USING (is_account_member(account_id));
DROP POLICY IF EXISTS conv_statuses_write ON conversation_statuses;
CREATE POLICY conv_statuses_write ON conversation_statuses
  FOR ALL USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Proteção dos SYSTEM no banco (o client sozinho é burlável via API direta):
-- não deixa deletar nem trocar a key / rebaixar is_system de uma linha system.
CREATE OR REPLACE FUNCTION protect_system_statuses()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'Status de sistema não pode ser removido';
    END IF;
    RETURN OLD;
  END IF;
  -- UPDATE: label/cor/sort livres; key e is_system imutáveis em system.
  IF OLD.is_system AND (NEW.key <> OLD.key OR NEW.is_system = false) THEN
    RAISE EXCEPTION 'Status de sistema: key/is_system são imutáveis';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_protect_system_statuses ON conversation_statuses;
CREATE TRIGGER trg_protect_system_statuses
  BEFORE UPDATE OR DELETE ON conversation_statuses
  FOR EACH ROW EXECUTE FUNCTION protect_system_statuses();

-- Seed p/ contas NOVAS: trigger AFTER INSERT ON accounts (cobre todo caminho
-- de criação — handle_new_user 017 e outros — sem mexer nessa função).
CREATE OR REPLACE FUNCTION seed_account_statuses()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO conversation_statuses (account_id, key, label, color, is_system, sort_order)
  VALUES (NEW.id, 'open',    'Aberta',     '#f97316', true, 0),
         (NEW.id, 'pending', 'Pendente',   '#f59e0b', true, 1),
         (NEW.id, 'closed',  'Finalizada', '#94a3b8', true, 2)
  ON CONFLICT (account_id, key) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_seed_account_statuses ON accounts;
CREATE TRIGGER trg_seed_account_statuses
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION seed_account_statuses();

-- Seed das 3 system p/ contas EXISTENTES (idempotente).
INSERT INTO conversation_statuses (account_id, key, label, color, is_system, sort_order)
SELECT a.id, v.key, v.label, v.color, true, v.ord
FROM accounts a
CROSS JOIN (VALUES ('open','Aberta','#f97316',0),
                   ('pending','Pendente','#f59e0b',1),
                   ('closed','Finalizada','#94a3b8',2)) AS v(key,label,color,ord)
ON CONFLICT (account_id, key) DO NOTHING;

-- Solta o CHECK de conversations.status (nome default do CHECK inline 001:144).
-- Validação passa p/ app: só grava key existente na tabela.
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_status_check;
