"use client";

// ============================================================
// Timeline do Pulso: conversas/dia por intenção (comercial ×
// suporte). Espelha a técnica do LineSvg de conversations-chart.tsx
// (viewBox fixo, hover via getScreenCTM inverso, crosshair, tooltip
// em div absoluto, nice ticks). Série "outro" só aparece no tooltip.
// ============================================================
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import { EmptyState } from "@/components/dashboard/empty-state";
import { Skeleton } from "@/components/dashboard/skeleton";
import type { PulseTimelinePoint } from "@/types";

const VB_W = 760;
const VB_H = 240;
const PADDING = { top: 16, right: 16, bottom: 28, left: 40 };

export function Timeline({ data, loading }: { data: PulseTimelinePoint[]; loading: boolean }) {
  const { t } = useTranslation(["pulse"]);

  // Max + ticks "bonitos" memoizados (espelha conversations-chart.tsx:34-46)
  const { maxY, niceTicks } = useMemo(() => {
    const max = data.reduce((m, p) => Math.max(m, p.vendas, p.suporte), 0);
    const ceil = niceCeil(max);
    const ticks = [0, ceil / 4, ceil / 2, (3 * ceil) / 4, ceil].map((v) => Math.round(v));
    return { maxY: ceil, niceTicks: Array.from(new Set(ticks)) };
  }, [data]);

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card">
      <header className="border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold text-foreground">{t("timelineTitle")}</h2>
      </header>
      <div className="p-5">
        {loading ? (
          <Skeleton className="h-[240px] w-full" />
        ) : data.length === 0 || data.every((p) => p.vendas === 0 && p.suporte === 0 && p.outro === 0) ? (
          <EmptyState icon={Activity} title={t("empty")} hint="" />
        ) : (
          <LineSvg data={data} maxY={maxY} ticks={niceTicks} t={t} />
        )}
      </div>
      <footer className="flex items-center gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground">
        <LegendDot color="#7c3aed" label={t("serieVendas")} />
        <LegendDot color="#3b82f6" label={t("serieSuporte")} />
      </footer>
    </section>
  );
}

// SVG com 2 polylines (vendas/suporte) + crosshair/tooltip por dia.
function LineSvg({
  data,
  maxY,
  ticks,
  t,
}: {
  data: PulseTimelinePoint[];
  maxY: number;
  ticks: number[];
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const [hover, setHover] = useState<{ idx: number; tooltipLeftPx: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const chartW = VB_W - PADDING.left - PADDING.right;
  const chartH = VB_H - PADDING.top - PADDING.bottom;
  const stepX = data.length > 1 ? chartW / (data.length - 1) : 0;
  const yFor = (v: number) =>
    maxY === 0 ? PADDING.top + chartH : PADDING.top + chartH - (v / maxY) * chartH;
  const xFor = (i: number) => PADDING.left + i * stepX;

  const vendasPath = data.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i)},${yFor(p.vendas)}`).join(" ");
  const suportePath = data.map((p, i) => `${i === 0 ? "M" : "L"}${xFor(i)},${yFor(p.suporte)}`).join(" ");

  // Hover via CTM inverso (mesma justificativa do conversations-chart.tsx:132-182:
  // preserveAspectRatio letterboxa e o cálculo por rect erra em telas largas).
  useEffect(() => {
    const svg = svgRef.current;
    const wrap = wrapRef.current;
    if (!svg || !wrap) return;
    const onMove = (e: MouseEvent) => {
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const local = pt.matrixTransform(ctm.inverse());
      if (local.x < PADDING.left - 8 || local.x > VB_W - PADDING.right + 8) {
        setHover(null);
        return;
      }
      const relative = local.x - PADDING.left;
      const idx = Math.max(0, Math.min(data.length - 1, Math.round(stepX === 0 ? 0 : relative / stepX)));
      const dataPointPt = svg.createSVGPoint();
      dataPointPt.x = PADDING.left + idx * stepX;
      dataPointPt.y = 0;
      const screen = dataPointPt.matrixTransform(ctm);
      const wrapRect = wrap.getBoundingClientRect();
      setHover({ idx, tooltipLeftPx: screen.x - wrapRect.left });
    };
    const onLeave = () => setHover(null);
    svg.addEventListener("mousemove", onMove);
    svg.addEventListener("mouseleave", onLeave);
    return () => {
      svg.removeEventListener("mousemove", onMove);
      svg.removeEventListener("mouseleave", onLeave);
    };
  }, [data, stepX]);

  const hovered = hover !== null ? data[hover.idx] : null;
  const hoverX = hover !== null ? xFor(hover.idx) : 0;
  const labelStride = Math.max(1, Math.ceil(data.length / 6));

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg ref={svgRef} viewBox={`0 0 ${VB_W} ${VB_H}`} className="h-[240px] w-full" role="img" aria-label={t("timelineTitle")}>
        {ticks.map((tick) => {
          const y = yFor(tick);
          return (
            <g key={tick}>
              <line x1={PADDING.left} x2={VB_W - PADDING.right} y1={y} y2={y} stroke="var(--border)" strokeDasharray="3 3" />
              <text x={PADDING.left - 8} y={y} textAnchor="end" dominantBaseline="middle" className="fill-muted-foreground text-[10px]">
                {tick}
              </text>
            </g>
          );
        })}
        {data.map((p, i) =>
          i % labelStride === 0 ? (
            <text key={p.dia} x={xFor(i)} y={VB_H - 8} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {shortDayLabel(p.dia)}
            </text>
          ) : null,
        )}
        <path d={vendasPath} fill="none" stroke="#7c3aed" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        <path d={suportePath} fill="none" stroke="#3b82f6" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={hoverX} x2={hoverX} y1={PADDING.top} y2={PADDING.top + chartH} stroke="var(--muted-foreground)" strokeDasharray="3 3" />
            <circle cx={hoverX} cy={yFor(data[hover.idx].vendas)} r={3.5} fill="#7c3aed" />
            <circle cx={hoverX} cy={yFor(data[hover.idx].suporte)} r={3.5} fill="#3b82f6" />
          </g>
        )}
      </svg>
      {hovered && hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: `${hover.tooltipLeftPx}px` }}
        >
          <div className="font-medium text-popover-foreground">{longDayLabel(hovered.dia)}</div>
          <div className="mt-1 flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-primary">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#7c3aed]" />
              {hovered.vendas} {t("serieVendas")}
            </span>
            <span className="flex items-center gap-1.5 text-blue-300">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
              {hovered.suporte} {t("serieSuporte")}
            </span>
            {hovered.outro > 0 && (
              <span className="text-muted-foreground">
                {hovered.outro} {t("serieOutro")}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// "YYYY-MM-DD" → rótulo curto/longo no fuso local (sem shift de meia-noite).
function shortDayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function longDayLabel(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Arredonda pra teto "bonito" (1/2/5/10×10^n) — espelha conversations-chart.tsx:331-341.
function niceCeil(max: number): number {
  if (max <= 0) return 4;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const normalised = max / pow;
  let nice: number;
  if (normalised <= 1) nice = 1;
  else if (normalised <= 2) nice = 2;
  else if (normalised <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}
