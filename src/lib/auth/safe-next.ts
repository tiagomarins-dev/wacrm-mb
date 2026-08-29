// Valida um destino de redirect vindo de query string (?next=). Puro e sem I/O:
// roda no middleware (Edge), em Route Handler e em Client Component. Total por
// contrato — nunca lança, porque o middleware é caminho de auth de toda
// requisição e uma exceção ali derruba o app inteiro.

/** Teto de tamanho: destino é path interno, não payload. */
export const MAX_NEXT_LENGTH = 512;

// Páginas de auth não são destino de navegação: aceitar `/login` como next monta
// cadeia de redirect (o bloco "já logado" do middleware devolveria ao próprio
// /login). `/api` fora porque destino é tela, não endpoint.
const BLOCKED_PATHS = [
  "/login",
  "/signup",
  "/forgot-password",
  "/auth",
  "/api",
];

// Controle (inclui tab e newline): alguns parsers de URL removem esses bytes
// antes de resolver, então um tab entre as barras vira `//evil.com` na prática.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Path relativo interno seguro, com a query própria preservada — ou null.
 *
 * A barra invertida é rejeitada porque `new URL("/\\evil.com", base)` resolve
 * para `https://evil.com/`: o parser trata `\` como `/` no authority. A query
 * NÃO é cortada — o destino real do deep-link é `/inbox/abrir?tel=…&nome=…`.
 */
export function parseSafeNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_NEXT_LENGTH) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\")) return null;
  if (CONTROL_CHARS.test(raw)) return null;

  // Casa SEGMENTO, não prefixo de string: `startsWith("/login")` barraria
  // `/logins-report`, que é rota legítima.
  const path = raw.split(/[?#]/)[0];
  if (BLOCKED_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) return null;

  return raw;
}

/** Wrapper com fallback, no formato que o callback de auth já consome. */
export function safeNextOrDefault(
  raw: string | null | undefined,
  fallback = "/dashboard",
): string {
  return parseSafeNext(raw) ?? fallback;
}
