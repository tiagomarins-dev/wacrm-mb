"use client";

// ============================================================
// "Atividade por hora" do Pulso: histograma 0h-23h de mensagens
// enviadas por atendentes HUMANOS no período, empilhado por tipo
// (RPC pulse_agent_hourly, 077). Barras por div (sem SVG); casca
// espelha timeline.tsx. Bucketização/cores no helper puro
// pulse-hourly.ts (testável isolado).
// ============================================================
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { PulseHourlyRow } from "@/types";
import {
  bucketHourly,
  HOURLY_TYPE_COLORS,
  HOURLY_TYPE_LABEL_KEY,
  HOURLY_TYPE_ORDER,
} from "@/lib/reports/pulse-hourly";

export function Hourly({ data, loading }: { data: PulseHourlyRow[]; loading: boolean }) {
  const { t } = useTranslation(["pulse"]);

  const buckets = useMemo(() => bucketHourly(data), [data]);
  // Math.max(1, ...) evita divisão por zero (padrão hbars.tsx)
  const maxTotal = Math.max(1, ...buckets.map((b) => b.total));
  const isEmpty = buckets.every((b) => b.total === 0);
  // Legenda só com tipos presentes no período
  const presentTypes = HOURLY_TYPE_ORDER.filter((tp) =>
    buckets.some((b) => (b.byType[tp] ?? 0) > 0),
  );

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t("hourlyTitle")}</h2>
        {/* Hint: só mensagens de humanos (slot novo — casca do timeline não tem) */}
        <p className="mt-0.5 text-xs text-muted-foreground">{t("hourlyHint")}</p>
      </header>
      <div className="p-5">
        {loading ? (
          <Skeleton className="h-[240px] w-full" />
        ) : isEmpty ? (
          <EmptyState icon={Activity} title={t("empty")} hint="" />
        ) : (
          <div>
            {/* Histograma: 24 colunas; altura relativa ao maior total/hora */}
            <div className="flex h-[200px] items-end gap-[2px]">
              {buckets.map((b) => (
                <div
                  key={b.hora}
                  className="flex flex-1 flex-col-reverse overflow-hidden rounded-t-sm"
                  style={{ height: `${(b.total / maxTotal) * 100}%` }}
                  title={
                    `${b.hora}h — ${b.total} msgs` +
                    HOURLY_TYPE_ORDER.filter((tp) => (b.byType[tp] ?? 0) > 0)
                      .map((tp) => `\n${t(HOURLY_TYPE_LABEL_KEY[tp])}: ${b.byType[tp]}`)
                      .join("")
                  }
                >
                  {/* Segmentos empilhados (base→topo) na ordem/cores do helper */}
                  {HOURLY_TYPE_ORDER.map((tp) => {
                    const v = b.byType[tp] ?? 0;
                    if (v === 0) return null;
                    return (
                      <div
                        key={tp}
                        className="w-full"
                        style={{
                          height: `${(v / b.total) * 100}%`,
                          background: HOURLY_TYPE_COLORS[tp],
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            {/* Eixo X: label a cada 3h pra não poluir */}
            <div className="mt-1 flex gap-[2px]">
              {buckets.map((b) => (
                <span
                  key={b.hora}
                  className="flex-1 text-center text-[10px] tabular-nums text-muted-foreground"
                >
                  {b.hora % 3 === 0 ? `${b.hora}h` : " "}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        {presentTypes.map((tp) => (
          <LegendDot
            key={tp}
            color={HOURLY_TYPE_COLORS[tp]}
            label={t(HOURLY_TYPE_LABEL_KEY[tp])}
          />
        ))}
      </footer>
    </section>
  );
}

// Espelho local do LegendDot da timeline.tsx (padrão: copiar, não importar).
function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
