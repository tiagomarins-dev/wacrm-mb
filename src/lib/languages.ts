/**
 * Catálogo de idiomas do sistema — fonte única de verdade.
 *
 * Espelha a forma de `themes.ts` (MODES/isMode/DEFAULT_MODE + META). A
 * diferença-chave: o idioma persiste em COOKIE (legível no server, para o
 * `<html lang>` sair certo já no 1º paint), enquanto tema/modo/fonte usam
 * localStorage (só-client). `dir="ltr"` vale para pt-BR e en (RTL fica para
 * uma fase futura — decisão consciente).
 */

export const LANGUAGES = ["pt-BR", "en"] as const;

export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = "pt-BR";

export const LANGUAGE_COOKIE = "wacrm.lang";

// Type guard — rejeita lixo antes de usar (mesma postura defensiva de isMode).
export function isLanguage(value: unknown): value is Language {
  return (
    typeof value === "string" &&
    (LANGUAGES as ReadonlyArray<string>).includes(value)
  );
}

export interface LanguageMeta {
  id: Language;
  /** Rótulo do picker, escrito no próprio idioma. */
  name: string;
}

export const LANGUAGES_META: ReadonlyArray<LanguageMeta> = [
  { id: "pt-BR", name: "Português (Brasil)" },
  { id: "en", name: "English" },
];
