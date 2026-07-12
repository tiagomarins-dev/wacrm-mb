import { cn } from "@/lib/utils";

// Pílula da intenção classificada por IA (report_intent, 053). Espelha o
// ClassificationBadge do lead-score. NULL/valor fora do enum → "—" discreto (fallback).
const MAP = {
  vendas: { cls: "bg-emerald-500/10 text-emerald-400" },
  suporte: { cls: "bg-sky-500/10 text-sky-400" },
  outro: { cls: "bg-slate-500/10 text-muted-foreground" },
} as const;

export function IntentBadge({
  value,
  label,
  className,
}: {
  value?: string | null;
  label?: string;
  className?: string;
}) {
  // NULL (não classificada) ou valor fora do enum → traço muted, sem pílula colorida.
  if (!value || !(value in MAP)) {
    return <span className={cn("text-xs text-muted-foreground", className)}>—</span>;
  }
  const m = MAP[value as keyof typeof MAP];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
        m.cls,
        className,
      )}
    >
      {label ?? value}
    </span>
  );
}
