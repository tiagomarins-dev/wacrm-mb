"use client";

// ============================================================
// Barras horizontais genéricas do Pulso (conexões / motivos /
// motivos de não-compra). Largura relativa ao maior valor.
// ============================================================
export interface HBarRow {
  label: string;
  value: number;
  color?: string;
}

export function HBars({ title, rows, emptyLabel }: { title: string; rows: HBarRow[]; emptyLabel: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center gap-2 text-xs">
              <span className="w-32 shrink-0 truncate text-muted-foreground" title={r.label}>{r.label}</span>
              <div className="h-2 flex-1 rounded-full bg-muted">
                <div
                  className="h-2 rounded-full"
                  style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--primary)" }}
                />
              </div>
              <span className="w-8 shrink-0 text-right font-medium tabular-nums text-foreground">{r.value}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
