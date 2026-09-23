// ============================================================
// Paginação da thread do inbox. A thread abre pelas mensagens MAIS
// RECENTES e busca as antigas sob demanda: o PostgREST corta toda
// resposta em 1.000 linhas, e uma busca crescente sem limite perderia
// justamente o fim da conversa (a janela de 24h também é calculada a
// partir do que foi carregado). Funções puras/testáveis.
// ============================================================
import type { Message } from "@/types";

// Mensagens por página. Bem abaixo do teto de 1.000 do PostgREST.
export const THREAD_PAGE_SIZE = 200;

// Página vem do banco em ordem DECRESCENTE (mais nova primeiro); a tela
// renderiza em ordem crescente. `hasOlder` = a página veio cheia, então
// pode haver mais antigas (falso positivo possível só quando o total é
// múltiplo exato do tamanho — o próximo clique volta vazio e desliga).
export function toThreadPage(
  rowsDesc: Message[],
  pageSize: number = THREAD_PAGE_SIZE,
): { messages: Message[]; hasOlder: boolean } {
  return { messages: [...rowsDesc].reverse(), hasOlder: rowsDesc.length >= pageSize };
}

// Junta as antigas na frente das carregadas. A busca das antigas usa
// `created_at <= mais antiga carregada` (não `<`) para não pular mensagens
// com o mesmo timestamp na fronteira; por isso o dedupe por id.
export function prependOlder(current: Message[], olderAsc: Message[]): Message[] {
  const seen = new Set(current.map((m) => m.id));
  return [...olderAsc.filter((m) => !seen.has(m.id)), ...current];
}

// Eventos e notas vêm inteiros; sem este corte, os anteriores à mensagem
// mais antiga carregada ficariam amontoados no topo, fora de contexto.
// Só corta quando ainda há histórico não carregado.
export function withinLoadedWindow<T extends { created_at: string }>(
  items: T[],
  oldestLoadedAt: string | undefined,
  hasOlder: boolean,
): T[] {
  if (!hasOlder || !oldestLoadedAt) return items;
  const since = new Date(oldestLoadedAt).getTime();
  return items.filter((i) => new Date(i.created_at).getTime() >= since);
}
