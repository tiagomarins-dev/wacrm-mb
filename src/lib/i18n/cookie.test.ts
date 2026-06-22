import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readLanguageCookie, writeLanguageCookie } from "./cookie";

// Ambiente de teste é `node` (sem jsdom) → stubamos document/location.
// Restauramos no afterEach para não vazar entre testes.
const realDocument = (globalThis as { document?: unknown }).document;
const realLocation = (globalThis as { location?: unknown }).location;

describe("i18n/cookie (client)", () => {
  beforeEach(() => {
    (globalThis as { document?: unknown }).document = { cookie: "" };
    (globalThis as { location?: unknown }).location = { protocol: "http:" };
  });
  afterEach(() => {
    (globalThis as { document?: unknown }).document = realDocument;
    (globalThis as { location?: unknown }).location = realLocation;
  });

  it("readLanguageCookie parseia o valor", () => {
    (globalThis as { document: { cookie: string } }).document.cookie =
      "foo=bar; wacrm.lang=pt-BR; baz=qux";
    expect(readLanguageCookie()).toBe("pt-BR");
  });

  it("readLanguageCookie retorna null quando ausente", () => {
    (globalThis as { document: { cookie: string } }).document.cookie = "foo=bar";
    expect(readLanguageCookie()).toBeNull();
  });

  it("writeLanguageCookie monta a string com samesite=lax e sem secure em http", () => {
    writeLanguageCookie("en");
    const written = (globalThis as { document: { cookie: string } }).document.cookie;
    expect(written).toContain("wacrm.lang=en");
    expect(written).toContain("samesite=lax");
    expect(written).toContain("max-age=31536000");
    expect(written).not.toContain("secure");
  });
});
