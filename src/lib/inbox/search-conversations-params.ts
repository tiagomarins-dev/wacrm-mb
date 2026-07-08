// ============================================================
// Monta os parâmetros da RPC `search_conversations` a partir do estado da tela
// Conversas. Função PURA (sem I/O) — testável. Regras:
//  - busca em mensagens só dispara com termo >= 3 chars (trgm degrada com 1-2);
//  - 'all'/'unassigned' viram os flags p_agent/p_unassigned;
//  - paginação por PAGE_SIZE.
// ============================================================
import { startOfWeek, startOfMonth, subMonths, endOfDay } from "date-fns";
import { startOfLocalDay } from "@/lib/dashboard/date-utils";

// Tamanho da página (espelha conversations/page.tsx:44).
export const PAGE_SIZE = 25;
// Abaixo disto a busca não vai pro banco (evita ILIKE '%a%').
const MIN_SEARCH = 3;

// Presets do filtro de data (por last_message_at). 'all' = sem filtro.
export type DateRange = "today" | "week" | "month" | "6m" | "12m" | "all" | "custom";

// Resolve o preset num intervalo [from,to] no FUSO LOCAL (espelha date-utils).
// Custom inválido (incompleto ou from>to) → {null,null} (= Todas), pra não
// filtrar por um range invertido silenciosamente.
export function resolveDateRange(
  range: DateRange,
  customFrom?: Date | null,
  customTo?: Date | null,
  now: Date = new Date(),
): { from: Date | null; to: Date | null } {
  switch (range) {
    case "today":
      return { from: startOfLocalDay(now), to: null };
    case "week":
      return { from: startOfWeek(now, { weekStartsOn: 1 }), to: null };
    case "month":
      return { from: startOfMonth(now), to: null };
    case "6m":
      return { from: subMonths(startOfLocalDay(now), 6), to: null };
    case "12m":
      return { from: subMonths(startOfLocalDay(now), 12), to: null };
    case "all":
      return { from: null, to: null };
    case "custom":
      if (!customFrom || !customTo || customFrom > customTo) return { from: null, to: null };
      return { from: startOfLocalDay(customFrom), to: endOfDay(customTo) };
  }
}

// Valor do filtro de responsável: 'all' / 'unassigned' / uuid (humano, perfil
// de IA ou o bot genérico AI_AGENT_USER_ID).
export type AgentFilter = "all" | "unassigned" | string;

export interface SearchInput {
  search: string;
  // 'all' ou a key de qualquer status da conta (system/custom, 062).
  statusFilter: string;
  agentFilter: AgentFilter;
  activeConnectionId: string | null;
  page: number;
  dateRange: DateRange;
  customFrom?: Date | null;
  customTo?: Date | null;
  // 'all' ou o uuid de uma tag da conta (filtro por tag do contato, 063).
  tagFilter: string;
}

export interface SearchParams {
  p_search: string | null;
  p_status: string | null;
  p_agent: string | null;
  p_unassigned: boolean;
  p_connection: string | null;
  p_date_from: string | null;
  p_date_to: string | null;
  p_tag: string | null;
  p_limit: number;
  p_offset: number;
}

// Traduz o estado da UI nos parâmetros da RPC.
export function buildSearchParams(i: SearchInput): SearchParams {
  const term = i.search.trim();
  // Intervalo de data no fuso local → ISO (timestamptz) pros params da RPC.
  const dr = resolveDateRange(i.dateRange, i.customFrom, i.customTo);
  return {
    p_search: term.length >= MIN_SEARCH ? term : null,
    p_status: i.statusFilter === "all" ? null : i.statusFilter,
    // 'all'/'unassigned' não são uuid → p_agent fica null; 'unassigned' liga o flag.
    p_agent:
      i.agentFilter !== "all" && i.agentFilter !== "unassigned" ? i.agentFilter : null,
    p_unassigned: i.agentFilter === "unassigned",
    p_connection: i.activeConnectionId ?? null,
    p_date_from: dr.from ? dr.from.toISOString() : null,
    p_date_to: dr.to ? dr.to.toISOString() : null,
    p_tag: i.tagFilter === "all" ? null : i.tagFilter,
    p_limit: PAGE_SIZE,
    p_offset: i.page * PAGE_SIZE,
  };
}
