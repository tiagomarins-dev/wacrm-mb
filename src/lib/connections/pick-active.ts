// ============================================================
// Escolhe a conexão ativa a partir da lista carregada: cookie (se
// ainda existe) → atual (se ainda existe) → primária → 1ª → null.
// Puro (sem React/cookie IO) p/ ser testável; o hook injeta os valores.
// ============================================================

export interface Pickable {
  id: string;
  is_primary: boolean;
}

// Resolve qual conexão deve ficar ativa, na ordem de preferência.
export function pickActiveConnectionId(
  list: Pickable[],
  cookieVal: string | null,
  prev: string | null,
): string | null {
  if (cookieVal && list.some((c) => c.id === cookieVal)) return cookieVal;
  if (prev && list.some((c) => c.id === prev)) return prev;
  return list.find((c) => c.is_primary)?.id ?? list[0]?.id ?? null;
}
