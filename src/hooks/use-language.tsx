"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { I18nextProvider } from "react-i18next";

import { createI18nInstance } from "@/lib/i18n";
import { writeLanguageCookie } from "@/lib/i18n/cookie";
import { DEFAULT_LANGUAGE, isLanguage, type Language } from "@/lib/languages";

/**
 * LanguageProvider — dono do idioma da UI (`useTranslation`/`t` via i18next).
 *
 * Espelha o `ThemeProvider` (provider client + setter + fallback fora do
 * provider), com duas divergências de propósito:
 *   • O idioma inicial vem do SERVER por prop (`initialLanguage`), lido do
 *     cookie em `app/layout.tsx`. Assim a instância i18next nasce no mesmo
 *     idioma que o server renderizou → zero hydration mismatch.
 *   • Sync entre abas usa `BroadcastChannel`, não o evento `storage` do tema:
 *     cookie não dispara `storage`.
 */

interface LanguageContextValue {
  language: Language;
  setLanguage: (next: Language) => void;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({
  initialLanguage,
  children,
}: {
  initialLanguage: Language;
  children: ReactNode;
}) {
  // Instância criada UMA vez com o idioma vindo do server (lazy initializer).
  const [i18n] = useState(() => createI18nInstance(initialLanguage));
  const [language, setLanguageState] = useState<Language>(initialLanguage);
  const bcRef = useRef<BroadcastChannel | null>(null);

  const setLanguage = useCallback(
    (next: Language) => {
      setLanguageState(next);
      void i18n.changeLanguage(next);
      writeLanguageCookie(next);
      if (typeof document !== "undefined") {
        document.documentElement.lang = next;
      }
      // Avisa outras abas — cookie NÃO emite o evento 'storage'.
      try {
        bcRef.current?.postMessage(next);
      } catch {
        // Canal indisponível (browser antigo) — degrada para o próximo load.
      }
    },
    [i18n],
  );

  // Sync entre abas via BroadcastChannel (troca o idioma na aba A → aba B
  // acompanha sem refresh). Cleanup obrigatório no unmount.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel("wacrm.lang");
    bcRef.current = bc;
    bc.onmessage = (e: MessageEvent) => {
      const next = e.data;
      if (isLanguage(next) && next !== language) {
        setLanguageState(next);
        void i18n.changeLanguage(next);
        document.documentElement.lang = next;
      }
    };
    return () => {
      bc.close();
      bcRef.current = null;
    };
  }, [i18n, language]);

  return (
    <I18nextProvider i18n={i18n}>
      <LanguageContext.Provider value={{ language, setLanguage }}>
        {children}
      </LanguageContext.Provider>
    </I18nextProvider>
  );
}

// Fallback fora do provider (no-op setter), espelhando `useTheme()`.
export function useLanguage(): LanguageContextValue {
  const ctx = useContext(LanguageContext);
  if (!ctx) {
    return { language: DEFAULT_LANGUAGE, setLanguage: () => {} };
  }
  return ctx;
}
