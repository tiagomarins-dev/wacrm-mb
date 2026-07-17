-- ============================================================
-- Classificação completa por IA (F2): motivo de contato (suporte), motivo de
-- não-compra (vendas) e flags qualitativas (base do Radar). Aditiva — mantém
-- report_intent/report_intent_at (053) intocados p/ retrocompat (sales-cron,
-- filtro 067, coverage 054). taxonomy_version controla re-análise em ondas.
-- ============================================================
alter table conversations add column if not exists report_motivo text;           -- duvida_uso|financeiro|erro_bug|reclamacao|outro
alter table conversations add column if not exists report_loss_reason text;      -- preco|vai_decidir|concorrente|parou_responder|nao_perdida
alter table conversations add column if not exists report_flags jsonb;           -- {sentimento_negativo,oportunidade_venda,aguardando_resposta} (booleans)
alter table conversations add column if not exists report_taxonomy_version int;  -- null = só intent v0; 1 = taxonomia atual

-- Varredura de pendentes SEM full-scan. ⚠️ Predicado IDÊNTICO ao filtro do worker
-- (or is-null / <> 1) — precisa casar com o .or() do PostgREST pro planner usar.
create index if not exists idx_conversations_taxonomy_pending
  on conversations(account_id, last_message_at)
  where (report_taxonomy_version is null or report_taxonomy_version <> 1);
