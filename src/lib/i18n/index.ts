import i18next, { type i18n as I18nInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import { resources, NAMESPACES, DEFAULT_NS } from "@/messages";
import { type Language } from "@/lib/languages";

/**
 * Cria uma instância DEDICADA do i18next por chamada.
 *
 * Nunca um singleton de módulo: no server isso vazaria o idioma de um usuário
 * para outro request; no client mantém a instância previsível por árvore.
 * `useSuspense:false` evita suspender durante a hidratação. `fallbackLng:"en"`
 * é o idioma das strings-fonte — chave faltando em pt-BR cai no inglês.
 */
export function createI18nInstance(lng: Language): I18nInstance {
  const instance = i18next.createInstance();
  instance.use(initReactI18next).init({
    lng,
    fallbackLng: "en",
    resources,
    ns: NAMESPACES as unknown as string[],
    defaultNS: DEFAULT_NS,
    react: { useSuspense: false },
    interpolation: { escapeValue: false }, // React já escapa o output
  });
  return instance;
}
