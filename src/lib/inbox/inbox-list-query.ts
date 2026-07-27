// ============================================================
// Política de query da LISTA do inbox + resolução do deep-link `?c=`.
// Funções PURAS (sem I/O, sem Date.now()) — o componente só orquestra.
// Existe porque o PostgREST corta o resultado em silêncio: sem um teto
// explícito e um detector de corte, conversas somem da UI sem nenhum sinal.
// ============================================================
import type { Conversation } from "@/types";

// Teto de linhas da lista. É o `db-max-rows` do PostgREST: pedir mais é capado
// em SILÊNCIO, então declarar acima disto dá falsa sensação de correção. Manter
// 1000 preserva exatamente o que a lista exibe hoje — o ganho é o corte virar
// detectável (isInboxListTruncated) em vez de invisível.
export const INBOX_LIST_LIMIT = 1000;

// Teto de ids na cláusula `id.in.(...)`. Cada UUID custa ~38 chars na
// querystring; acima de ~8 KB o proxy responde 414 e derruba a lista INTEIRA
// (não degrada: quebra).
export const MAX_FAVORITE_IDS_IN_FILTER = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Filtro `.or()` do working set: espelha em SQL o que classifyTab aceita nas
// abas RENDERIZADAS (fila/minhas/sla/ia — todas exigem !closed) mais a exceção
// dos favoritos, que a aba "Minhas" pina mesmo finalizados (queue.ts:45).
// Ids inválidos são DESCARTADOS (não lançam): a função é pura e pública, e
// vírgula/parêntese dentro de um id quebrariam a expressão do PostgREST.
export function buildInboxListFilter(favoriteIds: readonly string[]): string {
  // Ordenar antes de cortar mantém o corte determinístico (a origem é um Set).
  const valid = favoriteIds.filter((id) => UUID_RE.test(id)).sort();
  const capped = valid.slice(0, MAX_FAVORITE_IDS_IN_FILTER);
  if (capped.length < valid.length) {
    // Avisa: um corte silencioso aqui repetiria o bug que este módulo corrige.
    console.warn("Favorite ids truncated in inbox filter:", {
      total: valid.length,
      kept: capped.length,
      cap: MAX_FAVORITE_IDS_IN_FILTER,
    });
  }
  // `id.in.()` vazio é sintaxe inválida — sem favoritas, só a cláusula de status.
  if (capped.length === 0) return "status.neq.closed";
  return `status.neq.closed,id.in.(${capped.join(",")})`;
}

export type DeepLinkAction = { kind: "none" } | { kind: "fetch"; id: string };

// Decide o que fazer com o `?c=`. SEMPRE busca por id quando há o que resolver:
// procurar na lista carregada falha justamente para a conversa recém-criada,
// que fica no fim da ordenação (last_message_at null) e além do teto — e no
// mount a lista ainda está vazia, o que tornaria um ramo "select" indeterminado.
export function resolveDeepLink(args: {
  deepLinkId: string | null;
  consumedId: string | null;
  activeId: string | null;
}): DeepLinkAction {
  const { deepLinkId, consumedId, activeId } = args;
  if (!deepLinkId) return { kind: "none" };
  if (consumedId === deepLinkId) return { kind: "none" };
  if (activeId === deepLinkId) return { kind: "none" };
  return { kind: "fetch", id: deepLinkId };
}

// A conversa pertence ao conjunto que a lista exibe? Espelha as cláusulas da
// query — usado antes de o realtime dar prepend, porque o canal assina sem
// filtro algum (use-realtime.ts) e injetaria conversa de outra conexão.
// `connection_id` é NOT NULL no banco (036) mas opcional no tipo: ausente
// significa que não dá para afirmar pertencimento, logo false.
export function shouldMergeIntoInboxList(
  conv: Conversation,
  ctx: { activeConnectionId: string | null; favoriteIds: ReadonlySet<string> },
): boolean {
  if (ctx.activeConnectionId) {
    if (!conv.connection_id) return false;
    if (conv.connection_id !== ctx.activeConnectionId) return false;
  }
  if (conv.status === "closed" && !ctx.favoriteIds.has(conv.id)) return false;
  return true;
}

// Houve corte? `total` é o count exato do conjunto filtrado; null = count
// desligado, e aí não dá para afirmar truncamento — comparar `rows === limit`
// confundiria "cortado" com "exatamente no limite".
export function isInboxListTruncated(args: {
  rows: number;
  total: number | null;
  limit: number;
}): boolean {
  if (args.total === null) return false;
  return args.total > args.rows;
}

// Mantém a conversa ATIVA na lista mesmo quando ela não vem no conjunto
// retornado (deep-link além do teto, finalizada). Sem isso ela sumiria a cada
// refetch — que acontece em toda troca de aba do navegador. Devolve `loaded`
// por IDENTIDADE quando não há o que fazer, para não forçar re-render à toa.
export function mergeKeepingActive(
  loaded: Conversation[],
  active: Conversation | null,
): Conversation[] {
  if (!active) return loaded;
  if (loaded.some((c) => c.id === active.id)) return loaded;
  return [active, ...loaded];
}
