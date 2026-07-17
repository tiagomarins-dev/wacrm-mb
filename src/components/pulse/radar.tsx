"use client";

// ============================================================
// Radar do Pulso: 4 cards determinísticos das flags da classificação
// (068). Snapshot de agora (a RPC ignora janela). Mostra contagem +
// até 3 nomes + link simples p/ /conversations (sem deep-link — a
// página não lê searchParams p/ filtro).
// ============================================================
import Link from "next/link";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Sparkles, MailQuestion, Snowflake } from "lucide-react";
import type { PulseRadar, PulseRadarCard } from "@/types";

const CARDS = [
  { key: "churn", icon: AlertTriangle, tone: "border-red-500/30 bg-red-500/10 text-red-400" },
  { key: "oportunidades", icon: Sparkles, tone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" },
  { key: "aguardando", icon: MailQuestion, tone: "border-amber-500/30 bg-amber-500/10 text-amber-400" },
  { key: "esfriando", icon: Snowflake, tone: "border-blue-500/30 bg-blue-500/10 text-blue-400" },
] as const;

const LABEL_KEY: Record<(typeof CARDS)[number]["key"], string> = {
  churn: "radarChurn",
  oportunidades: "radarOportunidades",
  aguardando: "radarAguardando",
  esfriando: "radarEsfriando",
};

export function Radar({ radar, loading }: { radar: PulseRadar | null; loading: boolean }) {
  const { t } = useTranslation(["pulse"]);
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-foreground">{t("radarTitle")}</h2>
        {/* Radar é snapshot de agora (RPC sem janela) — sinaliza que o período não se aplica */}
        <p className="text-xs text-muted-foreground">{t("radarHint")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {CARDS.map(({ key, icon: Icon, tone }) => {
          const card: PulseRadarCard | undefined = radar?.[key];
          return (
            <div key={key} className={`rounded-lg border px-4 py-3 ${tone}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium">{t(LABEL_KEY[key])}</span>
                <Icon className="size-4 shrink-0" />
              </div>
              <p className="mt-2 text-2xl font-bold tabular-nums">
                {loading || !card ? "…" : card.total}
              </p>
              {card && card.sample.length > 0 && (
                <p className="mt-1 truncate text-[11px] opacity-80" title={card.sample.map((s) => s.contact_name ?? "—").join(", ")}>
                  {card.sample.map((s) => s.contact_name ?? "—").join(", ")}
                </p>
              )}
              {card && card.total > 0 && (
                <Link href="/conversations" className="mt-1 inline-block text-[11px] underline underline-offset-2 opacity-90 hover:opacity-100">
                  {t("radarViewAll")}
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
