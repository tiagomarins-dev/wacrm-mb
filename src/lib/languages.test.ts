import { describe, it, expect } from "vitest";
import { DEFAULT_LANGUAGE, LANGUAGES, isLanguage } from "./languages";

// Guard de idioma + padrão. Espelha o estilo de active.test.ts.
describe("languages", () => {
  it("padrão é pt-BR", () => {
    expect(DEFAULT_LANGUAGE).toBe("pt-BR");
    expect(LANGUAGES).toContain("pt-BR");
    expect(LANGUAGES).toContain("en");
  });

  it("isLanguage aceita os válidos", () => {
    expect(isLanguage("pt-BR")).toBe(true);
    expect(isLanguage("en")).toBe(true);
  });

  it("isLanguage rejeita lixo", () => {
    for (const bad of [null, undefined, "", "xx", "pt", 42, {}, []]) {
      expect(isLanguage(bad)).toBe(false);
    }
  });
});
