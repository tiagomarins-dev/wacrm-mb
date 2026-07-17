"use client";

// ============================================================
// Tiles do topo do Pulso: 5 métricas com delta ▲▼ vs janela
// anterior. Regras:
//  - "Sem resposta" é snapshot de agora → SEM delta (seria sempre 0).
//  - FRT/Resolução: queda é bom → sinal do delta invertido na cor.
//  - Resolução null → "—" + "coletando desde <data>" (evento nasce na 069).
// ============================================================
import { useTranslation } from "react-i18next";
import { MessagesSquare, Clock, Gauge, CheckCircle2, MailQuestion } from "lucide-react";
import { MetricCard } from "@/components/dashboard/metric-card";
import type { PulseTiles } from "@/types";

// Data em que o rastro de status começou a ser coletado (migration 069).
const COLLECTING_SINCE = "17/07/2026";

interface TilesProps {
  current: PulseTiles | null;
  previous: PulseTiles | null;
  loading: boolean;
}

// Monta o delta ▲▼; `invert` p/ métricas onde queda é bom (FRT/resolução).
function delta(
  cur: number | null | undefined,
  prev: number | null | undefined,
  unit: string,
  vsLabel: string,
  invert = false,
): { sign: number; label: string } | undefined {
  if (cur == null || prev == null) return undefined;
  const diff = cur - prev;
  const sign = invert ? -diff : diff;
  const fmt = Math.abs(diff) < 10 && !Number.isInteger(diff) ? Math.abs(diff).toFixed(1) : Math.round(Math.abs(diff)).toString();
  return { sign, label: `${diff >= 0 ? "+" : "−"}${fmt}${unit} ${vsLabel}` };
}

export function Tiles({ current, previous, loading }: TilesProps) {
  const { t } = useTranslation(["pulse"]);
  if (loading || !current) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[110px] animate-pulse rounded-xl border border-border bg-card" />
        ))}
      </div>
    );
  }
  const vs = t("deltaVsPrev");
  const fmtMin = (n: number | null) => (n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)}${t("minutesShort")}`);
  const fmtH = (n: number | null) => (n == null ? "—" : `${n < 10 ? n.toFixed(1) : Math.round(n)}${t("hoursShort")}`);
  const fmtPct = (n: number | null) => (n == null ? "—" : `${Math.round(n)}%`);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <MetricCard
        title={t("tileConversas")}
        value={String(current.conversas)}
        icon={MessagesSquare}
        delta={delta(current.conversas, previous?.conversas, "", vs)}
      />
      <MetricCard
        title={t("tileFrt")}
        value={fmtMin(current.frt_median)}
        icon={Clock}
        delta={delta(current.frt_median, previous?.frt_median, t("minutesShort"), vs, true)}
      />
      <MetricCard
        title={t("tileSla")}
        value={fmtPct(current.sla_pct)}
        icon={Gauge}
        delta={delta(current.sla_pct, previous?.sla_pct, "pp", vs)}
      />
      <MetricCard
        title={t("tileResolucao")}
        value={fmtH(current.resolucao_median)}
        icon={CheckCircle2}
        delta={
          current.resolucao_median == null
            ? undefined
            : delta(current.resolucao_median, previous?.resolucao_median, t("hoursShort"), vs, true)
        }
        subtitle={current.resolucao_median == null ? t("resolucaoCollecting", { date: COLLECTING_SINCE }) : undefined}
      />
      {/* Snapshot de agora — sem delta por decisão (H1 da auditoria) */}
      <MetricCard
        title={t("tileSemResposta")}
        value={String(current.sem_resposta)}
        icon={MailQuestion}
        subtitle={t("tileSemRespostaHint")}
      />
    </div>
  );
}
