// ============================================================
// URL do proxy de mídia — helper puro (multi-número 033).
// ============================================================

// Anexa o conversation_id à URL do proxy de mídia para o backend
// resolver o token da CONEXÃO certa. Sem id, ou para URLs que não
// são do proxy (ex.: CDN externo), devolve a URL intacta — aí o
// backend usa o fallback da conexão primária. Usa URLSearchParams
// p/ ser robusto a query preexistente e encodar o id corretamente.
export function withConversation(
  url: string,
  conversationId?: string | null,
): string {
  if (!conversationId || !url.startsWith("/api/whatsapp/media/")) {
    return url;
  }
  // base fictícia só p/ parsear um path relativo com segurança.
  const u = new URL(url, "http://internal");
  u.searchParams.set("conversationId", conversationId);
  return `${u.pathname}${u.search}`;
}
