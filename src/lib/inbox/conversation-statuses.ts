// ============================================================
// Resolve os status de conversa de uma conta. As 3 chaves de sistema têm
// defaults embutidos (fallback se o banco ainda não semeou) — o render nunca
// quebra. Custom vêm só do banco. Pura, sem React/DOM. Espelha assignee.ts.
// ============================================================
import type { ConversationStatusRow } from "@/types";

export interface ResolvedStatus {
  key: string;
  label: string;
  color: string; // hex
  is_system: boolean;
  sort_order: number;
}

// Defaults das 3 system — fallback quando a linha do banco falta (conta nova
// antes do seed, ou banco indisponível). Cores batem com o seed da mig 062.
export const SYSTEM_STATUS_DEFAULTS: ResolvedStatus[] = [
  { key: "open", label: "Aberta", color: "#f97316", is_system: true, sort_order: 0 },
  { key: "pending", label: "Pendente", color: "#f59e0b", is_system: true, sort_order: 1 },
  { key: "closed", label: "Finalizada", color: "#94a3b8", is_system: true, sort_order: 2 },
];

// Rows do banco sobrescrevem os defaults (por key); custom entram; ordena por
// sort_order (desempate alfabético). rows ausente → só os 3 defaults.
export function mergeStatuses(rows: ConversationStatusRow[] | undefined): ResolvedStatus[] {
  const byKey = new Map<string, ResolvedStatus>();
  for (const d of SYSTEM_STATUS_DEFAULTS) byKey.set(d.key, d);
  for (const r of rows ?? []) {
    byKey.set(r.key, {
      key: r.key,
      label: r.label,
      color: r.color,
      is_system: r.is_system,
      sort_order: r.sort_order,
    });
  }
  return [...byKey.values()].sort(
    (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label),
  );
}

// Lookup com fallback neutro p/ key órfã (status deletado ainda referenciado
// por uma conversa). Nunca quebra o render.
export function resolveStatus(
  list: ResolvedStatus[],
  key: string,
): { label: string; color: string } {
  const s = list.find((x) => x.key === key);
  return s ? { label: s.label, color: s.color } : { label: key, color: "#94a3b8" };
}
