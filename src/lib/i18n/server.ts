import "server-only";
import { cookies } from "next/headers";

import {
  DEFAULT_LANGUAGE,
  LANGUAGE_COOKIE,
  isLanguage,
  type Language,
} from "@/lib/languages";

/**
 * Resolve o idioma no SERVER a partir do cookie.
 *
 * Valida com `isLanguage` antes de usar (mesma postura defensiva de
 * `connections/active.ts` com o UUID_RE): valor ausente/inválido cai no
 * DEFAULT_LANGUAGE (pt-BR), nunca vira erro exposto. `cookies()` é async no
 * Next 16 (ver `active.ts:46`), por isso esta função é async.
 */
export async function resolveLanguageFromCookie(): Promise<Language> {
  const store = await cookies();
  const val = store.get(LANGUAGE_COOKIE)?.value;
  return isLanguage(val) ? val : DEFAULT_LANGUAGE;
}
