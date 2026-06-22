/**
 * Read/write do cookie de idioma no CLIENT.
 *
 * Espelha `readCookie`/`writeCookie` de `use-active-connection.tsx:52-66`
 * (mesmo regex de leitura + flags samesite/secure na escrita).
 *
 * ⚠️ NÃO importar `next/headers` aqui — este módulo é consumido por client
 * components. A leitura server-side fica em `i18n/server.ts`.
 */
import { LANGUAGE_COOKIE, type Language } from "@/lib/languages";

// Lê o cookie de idioma no client (ou null se ausente/SSR).
export function readLanguageCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${LANGUAGE_COOKIE}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

// Grava o cookie de idioma (SameSite=Lax, Secure em https, 1 ano; NÃO httpOnly
// — o client precisa lê-lo, igual ao cookie de conexão ativa).
export function writeLanguageCookie(lng: Language): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${LANGUAGE_COOKIE}=${encodeURIComponent(lng)}; path=/; max-age=31536000; samesite=lax${secure}`;
}
