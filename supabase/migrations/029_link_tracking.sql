-- ============================================================
-- 029 — Rastreamento de clique em link (Flows).
-- Adiciona o node_type `wait_for_link_click` e o evento `link_clicked`,
-- + tabela `link_clicks` (auditoria/analytics, multi-superfície).
-- Idempotente: DROP CONSTRAINT IF EXISTS + ADD (não dá pra ALTER um
-- CHECK inline). RLS account-scoped via is_account_member (pós-017).
-- ============================================================

-- 1) nó novo: wait_for_link_click
ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check CHECK (node_type IN (
  'start','send_message','send_buttons','send_list','send_media',
  'wait_for_link_click','collect_input','condition','set_tag','handoff','end'
));

-- 2) evento novo: link_clicked (espelha a union TS em engine.ts logEvent)
ALTER TABLE flow_run_events DROP CONSTRAINT IF EXISTS flow_run_events_event_type_check;
ALTER TABLE flow_run_events ADD CONSTRAINT flow_run_events_event_type_check CHECK (event_type IN (
  'started','node_entered','message_sent','reply_received','fallback_fired',
  'handoff','timeout','link_clicked','error','completed'
));

-- 3) auditoria/analytics dos cliques (só cliques humanos — bot é filtrado na rota)
CREATE TABLE IF NOT EXISTS link_clicks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  flow_run_id UUID REFERENCES flow_runs(id) ON DELETE SET NULL,
  node_key TEXT,
  source TEXT NOT NULL DEFAULT 'flow' CHECK (source IN ('flow','broadcast','automation','manual')),
  target_url TEXT NOT NULL,
  user_agent TEXT,
  clicked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_link_clicks_account
  ON link_clicks(account_id, clicked_at DESC);

ALTER TABLE link_clicks ENABLE ROW LEVEL SECURITY;

-- SELECT: qualquer membro da conta (pós-017). INSERT é só via service-role
-- (a rota /r/[token]), que ignora RLS — por isso não há policy de insert.
DROP POLICY IF EXISTS link_clicks_select ON link_clicks;
CREATE POLICY link_clicks_select ON link_clicks FOR SELECT
  USING (is_account_member(account_id));
