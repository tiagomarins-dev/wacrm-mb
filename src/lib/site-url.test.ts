import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// `server-only` lança fora de um bundle server (RSC); no vitest é no-op.
vi.mock("server-only", () => ({}));

import { getSiteUrl } from "./site-url";

// Isola process.env: salva/restaura SITE_URL + NEXT_PUBLIC_SITE_URL entre casos
// p/ não vazar estado pra outros testes (ex.: tools.test.ts depende de
// NEXT_PUBLIC_SITE_URL setado). Sem isso, a suíte fica flaky por ordem.
describe("getSiteUrl", () => {
  const saved = {
    site: process.env.SITE_URL,
    pub: process.env.NEXT_PUBLIC_SITE_URL,
  };

  beforeEach(() => {
    delete process.env.SITE_URL;
    delete process.env.NEXT_PUBLIC_SITE_URL;
  });

  afterEach(() => {
    if (saved.site === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = saved.site;
    if (saved.pub === undefined) delete process.env.NEXT_PUBLIC_SITE_URL;
    else process.env.NEXT_PUBLIC_SITE_URL = saved.pub;
  });

  it("SITE_URL vence NEXT_PUBLIC_SITE_URL", () => {
    process.env.SITE_URL = "https://runtime.example.com";
    process.env.NEXT_PUBLIC_SITE_URL = "https://build.example.com";
    expect(getSiteUrl()).toBe("https://runtime.example.com");
  });

  it("fallback p/ NEXT_PUBLIC_SITE_URL quando SITE_URL ausente", () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://build.example.com";
    expect(getSiteUrl()).toBe("https://build.example.com");
  });

  it("tira barra(s) final", () => {
    process.env.SITE_URL = "https://x.com//";
    expect(getSiteUrl()).toBe("https://x.com");
  });

  it("whitespace cai no fallback / undefined", () => {
    process.env.SITE_URL = "   ";
    process.env.NEXT_PUBLIC_SITE_URL = "https://build.example.com";
    expect(getSiteUrl()).toBe("https://build.example.com");
  });

  it("ambos ausentes → undefined", () => {
    expect(getSiteUrl()).toBeUndefined();
  });

  it("valor inválido (não-URL ou protocolo não-http) → undefined", () => {
    process.env.SITE_URL = "javascript:alert(1)";
    expect(getSiteUrl()).toBeUndefined();
    process.env.SITE_URL = "not-a-url";
    expect(getSiteUrl()).toBeUndefined();
  });
});
