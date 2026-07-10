// Detecção de URL e montagem de partes linkificáveis. Fonte ÚNICA usada pelo wrap
// (envio) e pela bolha (exibição) → href e token nunca divergem.

// Regex de URL http(s) e de pontuação/símbolo final que a regex ingênua engoliria
// (o "." final de "veja https://x.com/p." não faz parte da URL).
const URL_RE = /https?:\/\/[^\s<]+/gi;
const TRAIL = /[.,;:!?)»"'”’\]]+$/;
// Token manual/agent no fim de uma URL /r/<32-hex>. Mesmo shape do badge (message-bubble.tsx:431).
const TOKEN_RE = /\/r\/([a-f0-9]{32})$/;

// Acha as URLs http(s) do texto, aparando pontuação final. Retorna posição p/ substituição.
export function findUrls(text: string): { url: string; start: number; end: number }[] {
  const out: { url: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(TRAIL, "");
    out.push({ url, start: m.index!, end: m.index! + url.length });
  }
  return out;
}

// Extrai os 32 hex de uma URL .../r/<token>; null se não for link rastreável.
export function extractManualToken(url: string): string | null {
  const m = url.match(TOKEN_RE);
  return m ? m[1] : null;
}

// Parte de texto renderizável pela bolha. 'raw' = /r/ ainda sem original (flip otimista) → texto puro.
export type LinkPart =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; label: string }
  | { kind: "raw"; text: string };

// Quebra o texto em partes texto/link. URLs /r/<token> resolvem via tokenMap (→ original clicável);
// sem original ainda → 'raw' (texto puro, evita o atendente clicar o /r/). URL comum → link direto.
export function buildLinkParts(
  text: string,
  tokenMap: Record<string, string>,
): LinkPart[] {
  const urls = findUrls(text);
  if (urls.length === 0) return [{ kind: "text", text }];
  const parts: LinkPart[] = [];
  let cursor = 0;
  for (const { url, start, end } of urls) {
    if (start > cursor) parts.push({ kind: "text", text: text.slice(cursor, start) });
    const token = extractManualToken(url);
    if (token) {
      const original = tokenMap[token];
      if (original) parts.push({ kind: "link", href: original, label: original });
      else parts.push({ kind: "raw", text: url }); // ainda não resolvido → texto puro
    } else {
      parts.push({ kind: "link", href: url, label: url });
    }
    cursor = end;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts;
}
