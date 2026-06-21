-- ============================================================
-- 031 — Lead Score: flag de venda no clique + config por conta + RPCs.
-- Score determinístico ponderado, calculado AO VIVO via RPC (sem cron).
-- Idempotente. RLS via is_account_member (pós-017). RPCs SECURITY DEFINER
-- resolvem a conta por auth.uid() (sem param account → sem cross-account).
-- ============================================================

-- 1) flag de venda no clique (mig 029). Link de venda vale 2x no score.
ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS is_sale BOOLEAN NOT NULL DEFAULT false;
-- índice p/ as agregações por contato (só havia por account+clicked_at).
CREATE INDEX IF NOT EXISTS idx_link_clicks_contact ON link_clicks(contact_id, clicked_at DESC);

-- 2) config por conta (pesos/janela/limiares), admin-only (espelha 027).
CREATE TABLE IF NOT EXISTS lead_score_config (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  msg_weight      INTEGER NOT NULL DEFAULT 1,
  button_weight   INTEGER NOT NULL DEFAULT 3,
  link_weight     INTEGER NOT NULL DEFAULT 5,
  sale_multiplier NUMERIC  NOT NULL DEFAULT 2,
  window_days     INTEGER NOT NULL DEFAULT 30,
  hot_threshold   INTEGER NOT NULL DEFAULT 50,
  warm_threshold  INTEGER NOT NULL DEFAULT 20,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE lead_score_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_score_config_rw ON lead_score_config;
CREATE POLICY lead_score_config_rw ON lead_score_config FOR ALL
  USING (is_account_member(account_id,'admin')) WITH CHECK (is_account_member(account_id,'admin'));
DROP TRIGGER IF EXISTS set_updated_at ON lead_score_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON lead_score_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 3) RPC de ranking (ao vivo). Conta resolvida por auth.uid() (sem param → sem spoof).
--    Mantém a MESMA fórmula de src/lib/lead-score/score.ts (manter em sincronia).
CREATE OR REPLACE FUNCTION lead_scores(p_window_days int DEFAULT NULL)
RETURNS TABLE(contact_id uuid, conversation_id uuid, name text, phone text,
  msg_count int, button_count int, link_count int, sale_count int,
  score int, classification text, last_interaction_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
-- OUT params (name/phone/...) colidem com colunas homônimas → resolve p/ coluna.
#variable_conflict use_column
DECLARE acc uuid; w_msg int; w_btn int; w_link int; mult numeric; wdays int; hot int; warm int; since timestamptz;
BEGIN
  -- conta do caller (sem aceitar account_id por param → impede cross-account)
  SELECT account_id INTO acc FROM profiles WHERE user_id = auth.uid();
  IF acc IS NULL OR NOT is_account_member(acc) THEN RETURN; END IF;
  SELECT msg_weight, button_weight, link_weight, sale_multiplier, window_days, hot_threshold, warm_threshold
    INTO w_msg, w_btn, w_link, mult, wdays, hot, warm
    FROM lead_score_config WHERE account_id = acc;
  w_msg:=coalesce(w_msg,1); w_btn:=coalesce(w_btn,3); w_link:=coalesce(w_link,5);
  mult:=coalesce(mult,2); wdays:=coalesce(p_window_days, wdays, 30); hot:=coalesce(hot,50); warm:=coalesce(warm,20);
  since := now() - (wdays || ' days')::interval;

  RETURN QUERY
  WITH msg AS (
    -- mensagem = inbound não-interativo; botão = inbound com interactive_reply_id
    SELECT conv.contact_id AS cid,
      count(*) FILTER (WHERE m.interactive_reply_id IS NULL)::int     AS msgs,
      count(*) FILTER (WHERE m.interactive_reply_id IS NOT NULL)::int AS btns,
      max(m.created_at) AS last_msg
    FROM messages m
    JOIN conversations conv ON conv.id = m.conversation_id
    WHERE conv.account_id = acc AND m.sender_type = 'customer' AND m.created_at >= since
    GROUP BY conv.contact_id
  ),
  lk AS (
    SELECT contact_id AS cid, count(*)::int AS links,
      count(*) FILTER (WHERE is_sale)::int AS sales, max(clicked_at) AS last_click
    FROM link_clicks
    WHERE account_id = acc AND contact_id IS NOT NULL AND clicked_at >= since
    GROUP BY contact_id
  ),
  agg AS (
    SELECT c.id, c.name, c.phone,
      coalesce(msg.msgs,0) AS m, coalesce(msg.btns,0) AS b,
      coalesce(lk.links,0) AS l, coalesce(lk.sales,0) AS s,
      greatest(msg.last_msg, lk.last_click) AS last_at
    FROM contacts c
    LEFT JOIN msg ON msg.cid = c.id
    LEFT JOIN lk  ON lk.cid  = c.id
    WHERE c.account_id = acc AND (msg.cid IS NOT NULL OR lk.cid IS NOT NULL)
  ),
  scored AS (
    -- fórmula: msgs*wm + botões*wb + (links-vendas)*wl + vendas*round(wl*mult)
    SELECT *, (m*w_msg + b*w_btn + (l-s)*w_link + s*round(w_link*mult))::int AS sc FROM agg
  )
  SELECT scored.id,
    -- conversa mais recente do contato (p/ abrir o chat no inbox)
    (SELECT cv.id FROM conversations cv WHERE cv.account_id=acc AND cv.contact_id=scored.id
       ORDER BY cv.updated_at DESC NULLS LAST LIMIT 1),
    scored.name, scored.phone, scored.m, scored.b, scored.l, scored.s, scored.sc,
    CASE WHEN scored.sc >= hot THEN 'quente' WHEN scored.sc >= warm THEN 'morno' ELSE 'frio' END,
    scored.last_at
  FROM scored ORDER BY scored.sc DESC;
END $$;
GRANT EXECUTE ON FUNCTION lead_scores(int) TO authenticated;

-- 4) RPC por contato (perfil). Mesma fórmula; 1 contato; valida a conta.
CREATE OR REPLACE FUNCTION lead_score_contact(p_contact_id uuid, p_window_days int DEFAULT NULL)
RETURNS TABLE(contact_id uuid, msg_count int, button_count int, link_count int, sale_count int,
  score int, classification text, last_interaction_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
-- OUT param contact_id colide com link_clicks.contact_id → resolve p/ coluna.
#variable_conflict use_column
DECLARE acc uuid; w_msg int; w_btn int; w_link int; mult numeric; wdays int; hot int; warm int; since timestamptz;
        v_m int; v_b int; v_l int; v_s int; v_last_msg timestamptz; v_last_click timestamptz; v_sc int;
BEGIN
  SELECT account_id INTO acc FROM profiles WHERE user_id = auth.uid();
  IF acc IS NULL OR NOT is_account_member(acc) THEN RETURN; END IF;
  -- o contato precisa ser da conta do caller
  IF NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = p_contact_id AND c.account_id = acc) THEN RETURN; END IF;
  SELECT msg_weight, button_weight, link_weight, sale_multiplier, window_days, hot_threshold, warm_threshold
    INTO w_msg, w_btn, w_link, mult, wdays, hot, warm FROM lead_score_config WHERE account_id = acc;
  w_msg:=coalesce(w_msg,1); w_btn:=coalesce(w_btn,3); w_link:=coalesce(w_link,5);
  mult:=coalesce(mult,2); wdays:=coalesce(p_window_days, wdays, 30); hot:=coalesce(hot,50); warm:=coalesce(warm,20);
  since := now() - (wdays || ' days')::interval;

  SELECT count(*) FILTER (WHERE m.interactive_reply_id IS NULL),
         count(*) FILTER (WHERE m.interactive_reply_id IS NOT NULL),
         max(m.created_at)
    INTO v_m, v_b, v_last_msg
    FROM messages m JOIN conversations conv ON conv.id = m.conversation_id
    WHERE conv.account_id = acc AND conv.contact_id = p_contact_id
      AND m.sender_type = 'customer' AND m.created_at >= since;
  SELECT count(*), count(*) FILTER (WHERE lc.is_sale), max(lc.clicked_at)
    INTO v_l, v_s, v_last_click
    FROM link_clicks lc WHERE lc.account_id = acc AND lc.contact_id = p_contact_id AND lc.clicked_at >= since;
  v_m:=coalesce(v_m,0); v_b:=coalesce(v_b,0); v_l:=coalesce(v_l,0); v_s:=coalesce(v_s,0);
  v_sc := (v_m*w_msg + v_b*w_btn + (v_l-v_s)*w_link + v_s*round(w_link*mult))::int;
  RETURN QUERY SELECT p_contact_id, v_m, v_b, v_l, v_s, v_sc,
    CASE WHEN v_sc >= hot THEN 'quente' WHEN v_sc >= warm THEN 'morno' ELSE 'frio' END,
    greatest(v_last_msg, v_last_click);
END $$;
GRANT EXECUTE ON FUNCTION lead_score_contact(uuid,int) TO authenticated;
