// ============================================================
// Monta os parâmetros da RPC `search_conversations` a partir do estado da tela
// Conversas. Função PURA (sem I/O) — testável. Regras:
//  - busca em mensagens só dispara com termo >= 3 chars (trgm degrada com 1-2);
//  - 'all'/'unassigned' viram os flags p_agent/p_unassigned;
//  - paginação por PAGE_SIZE.
// ============================================================
import type { ConversationStatus } from "@/types";

// Tamanho da página (espelha conversations/page.tsx:44).
export const PAGE_SIZE = 25;
// Abaixo disto a busca não vai pro banco (evita ILIKE '%a%').
const MIN_SEARCH = 3;

// Valor do filtro de responsável: 'all' / 'unassigned' / uuid (humano, perfil
// de IA ou o bot genérico AI_AGENT_USER_ID).
export type AgentFilter = "all" | "unassigned" | string;

export interface SearchInput {
  search: string;
  statusFilter: "all" | ConversationStatus;
  agentFilter: AgentFilter;
  activeConnectionId: string | null;
  page: number;
}

export interface SearchParams {
  p_search: string | null;
  p_status: string | null;
  p_agent: string | null;
  p_unassigned: boolean;
  p_connection: string | null;
  p_limit: number;
  p_offset: number;
}

// Traduz o estado da UI nos parâmetros da RPC.
export function buildSearchParams(i: SearchInput): SearchParams {
  const term = i.search.trim();
  return {
    p_search: term.length >= MIN_SEARCH ? term : null,
    p_status: i.statusFilter === "all" ? null : i.statusFilter,
    // 'all'/'unassigned' não são uuid → p_agent fica null; 'unassigned' liga o flag.
    p_agent:
      i.agentFilter !== "all" && i.agentFilter !== "unassigned" ? i.agentFilter : null,
    p_unassigned: i.agentFilter === "unassigned",
    p_connection: i.activeConnectionId ?? null,
    p_limit: PAGE_SIZE,
    p_offset: i.page * PAGE_SIZE,
  };
}
