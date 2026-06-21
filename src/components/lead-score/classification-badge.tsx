import { cn } from "@/lib/utils";

// Pílula de classificação do Lead Score (quente/morno/frio). Mesmo padrão
// visual das tags coloridas (contacts/page). Usada na página de ranking,
// na lista de Contatos e no perfil.
const MAP = {
  quente: { label: "Quente", cls: "bg-red-500/10 text-red-400" },
  morno: { label: "Morno", cls: "bg-amber-500/10 text-amber-400" },
  frio: { label: "Frio", cls: "bg-slate-500/10 text-muted-foreground" },
} as const;

export type LeadClassification = keyof typeof MAP;

export function ClassificationBadge({
  value,
  className,
}: {
  value: LeadClassification;
  className?: string;
}) {
  const m = MAP[value] ?? MAP.frio;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
        m.cls,
        className,
      )}
    >
      {m.label}
    </span>
  );
}
