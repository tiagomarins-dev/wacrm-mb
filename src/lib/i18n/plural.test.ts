import { describe, it, expect } from "vitest";
import { createI18nInstance } from "./index";

// Plural pt-BR via i18next (_one/_other resolvidos por Intl.PluralRules).
describe("i18n plural (pt-BR)", () => {
  const i18n = createI18nInstance("pt-BR");

  it("singular usa _one", () => {
    expect(i18n.t("contacts:deletedToast", { count: 1 })).toBe("1 contato excluído");
  });

  it("plural usa _other", () => {
    expect(i18n.t("contacts:deletedToast", { count: 2 })).toBe("2 contatos excluídos");
  });

  it("pt-BR trata 0 como _one (CLDR: one = 0,1) — difere do inglês", () => {
    // pt-BR: "0 contato excluído"  ·  en: "0 contacts deleted"
    expect(i18n.t("contacts:deletedToast", { count: 0 })).toBe("0 contato excluído");
    const en = createI18nInstance("en");
    expect(en.t("contacts:deletedToast", { count: 0 })).toBe("0 contacts deleted");
  });

  it("fallback para en quando idioma é en", () => {
    const en = createI18nInstance("en");
    expect(en.t("contacts:deletedToast", { count: 1 })).toBe("1 contact deleted");
  });
});
