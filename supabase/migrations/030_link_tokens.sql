-- ============================================================
-- 030 — Token curto p/ link rastreável.
-- O token stateless (HMAC) ficava enorme na URL e o WhatsApp só tornava
-- clicável a 1ª parte (quebra em chars do base64). Trocamos por um id
-- aleatório curto (capability) persistido: /r/<id-hex-32>. A linha guarda
-- o destino + alvo da run. Só service-role lê (a rota /r). RLS sem policy
-- = fail-closed pra clientes.
-- ============================================================

CREATE TABLE IF NOT EXISTS link_tokens (
  id TEXT PRIMARY KEY,                       -- hex aleatório (128 bits)
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL,
  run_id UUID NOT NULL REFERENCES flow_runs(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_link_tokens_run ON link_tokens(run_id);

ALTER TABLE link_tokens ENABLE ROW LEVEL SECURITY;
-- Sem policy: nenhum acesso via RLS (clientes). A rota /r usa service-role
-- (ignora RLS). O id é a capability — não deve ser legível por RLS.
