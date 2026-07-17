// ============================================================
// Resolução de janelas de período da página /pulse. Função PURA
// (espelha resolveDateRange de search-conversations-params.ts).
// Devolve a janela atual + a anterior (mesmo tamanho, imediatamente
// antes) p/ o delta dos tiles, e a flag endsNow p/ a tabela por
// atendente (RPCs 050/052 contam de now()−N dias — só valem quando
// a janela termina ≈agora).
// ============================================================
import { endOfDay, startOfMonth, subDays } from "date-fns";
import { startOfLocalDay } from "@/lib/dashboard/date-utils";

// Presets de período da página /pulse
export type PulsePreset = "today" | "7d" | "30d" | "90d" | "month" | "custom";

export interface PulseWindow {
  from: Date;
  to: Date;
  prevFrom: Date;
  prevTo: Date;
  endsNow: boolean;
  windowDays: number; // p/ p_window_days da AgentsTable (ceil)
}

// Resolve preset/custom em janelas. Custom inválido (faltando ou invertido) → null.
export function resolvePulseWindow(
  preset: PulsePreset,
  customFrom?: Date | null,
  customTo?: Date | null,
  now: Date = new Date(),
): PulseWindow | null {
  let from: Date;
  let to: Date;
  let endsNow = true;
  switch (preset) {
    case "today":
      from = startOfLocalDay(now); to = now; break;
    case "7d":
      from = subDays(startOfLocalDay(now), 7); to = now; break;
    case "30d":
      from = subDays(startOfLocalDay(now), 30); to = now; break;
    case "90d":
      from = subDays(startOfLocalDay(now), 90); to = now; break;
    case "month":
      from = startOfMonth(now); to = now; break;
    case "custom": {
      if (!customFrom || !customTo || customFrom > customTo) return null;
      from = startOfLocalDay(customFrom);
      const end = endOfDay(customTo);
      // não deixa a janela invadir o futuro
      to = end > now ? now : end;
      endsNow = end >= now || now.getTime() - end.getTime() < 24 * 60 * 60 * 1000;
      break;
    }
  }
  const span = to.getTime() - from.getTime();
  return {
    from,
    to,
    prevFrom: new Date(from.getTime() - span),
    prevTo: from,
    endsNow,
    windowDays: Math.max(1, Math.ceil(span / (24 * 60 * 60 * 1000))),
  };
}
