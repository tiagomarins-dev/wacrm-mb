// ============================================================
// Bucketização do histograma "Atividade por hora" do /pulse.
// Função PURA: transforma as linhas da RPC pulse_agent_hourly (077)
// em 24 buckets (0-23) SEMPRE presentes (gap-filling aqui, não no
// SQL). Tipos raros/desconhecidos caem em 'other' pra legenda não
// explodir. Cores/ordem centralizadas aqui (fonte única da UI).
// ============================================================
import type { PulseHourlyRow } from "@/types";

// Ordem de empilhamento (base→topo) e da legenda. 'other' sempre no fim.
export const HOURLY_TYPE_ORDER = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "template",
  "other",
] as const;
export type HourlyType = (typeof HOURLY_TYPE_ORDER)[number];

// Paleta alinhada às cores já usadas no Pulso (page.tsx funil/motivos).
export const HOURLY_TYPE_COLORS: Record<HourlyType, string> = {
  text: "#3b82f6",
  image: "#10b981",
  audio: "#f59e0b",
  video: "#ef4444",
  document: "#7c3aed",
  template: "#06b6d4",
  other: "#6b7280",
};

// Chave i18n do label de cada tipo (namespace pulse).
export const HOURLY_TYPE_LABEL_KEY: Record<HourlyType, string> = {
  text: "typeText",
  image: "typeImage",
  audio: "typeAudio",
  video: "typeVideo",
  document: "typeDocument",
  template: "typeTemplate",
  other: "typeOther",
};

export interface HourlyBucket {
  hora: number;
  byType: Partial<Record<HourlyType, number>>;
  total: number;
}

// Normaliza o content_type cru da RPC: location/interactive/desconhecidos → 'other'.
function normalizeType(contentType: string): HourlyType {
  return (HOURLY_TYPE_ORDER as readonly string[]).includes(contentType) &&
    contentType !== "other"
    ? (contentType as HourlyType)
    : "other";
}

// Sempre devolve 24 posições (0..23), zeradas quando sem dados.
export function bucketHourly(rows: PulseHourlyRow[]): HourlyBucket[] {
  const buckets: HourlyBucket[] = Array.from({ length: 24 }, (_, hora) => ({
    hora,
    byType: {},
    total: 0,
  }));
  for (const r of rows ?? []) {
    if (!Number.isInteger(r.hora) || r.hora < 0 || r.hora > 23) continue;
    const tipo = normalizeType(r.content_type);
    const b = buckets[r.hora];
    b.byType[tipo] = (b.byType[tipo] ?? 0) + r.msgs;
    b.total += r.msgs;
  }
  return buckets;
}
