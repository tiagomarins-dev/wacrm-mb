// ============================================================
// Validador do ?next=. Dois consumidores com a MESMA superfície de ataque: o
// middleware (que resolve com `new URL(next, request.url)`) e a página de login
// (que faz `router.replace(next)` logo depois da senha ser digitada). Os casos
// de open-redirect valem para os dois — por isso moram aqui, e não em cada um.
// ============================================================
import { describe, it, expect } from "vitest";
import { parseSafeNext, safeNextOrDefault, MAX_NEXT_LENGTH } from "./safe-next";

describe("parseSafeNext", () => {
  it("aceita path interno simples", () => {
    expect(parseSafeNext("/inbox")).toBe("/inbox");
    expect(parseSafeNext("/dashboard")).toBe("/dashboard");
  });

  it("preserva a query própria do destino", () => {
    // É o requisito central: o deep-link carrega tel e nome na query.
    const dest = "/inbox/abrir?tel=5521999998888&nome=Ana";
    expect(parseSafeNext(dest)).toBe(dest);
  });

  it("preserva o hash", () => {
    expect(parseSafeNext("/contacts#lista")).toBe("/contacts#lista");
  });

  it("bloqueia barra invertida (o motivo de este módulo existir)", () => {
    // `new URL("/\\evil.com", "https://app.test")` resolve p/ https://evil.com/
    expect(parseSafeNext("/\\evil.com")).toBeNull();
    expect(parseSafeNext("/\\/evil.com")).toBeNull();
    expect(parseSafeNext("/inbox\\evil.com")).toBeNull();
  });

  it("bloqueia caractere de controle, inclusive tab e newline", () => {
    expect(parseSafeNext("/\t/evil.com")).toBeNull();
    expect(parseSafeNext("/inbox\nX")).toBeNull();
    expect(parseSafeNext("/inbox\u0000")).toBeNull();
    expect(parseSafeNext("/inbox\u007F")).toBeNull();
  });

  it("bloqueia protocol-relative e URL absoluta", () => {
    expect(parseSafeNext("//evil.com")).toBeNull();
    expect(parseSafeNext("https://evil.com")).toBeNull();
    expect(parseSafeNext("http://evil.com")).toBeNull();
    expect(parseSafeNext("javascript:alert(1)")).toBeNull();
  });

  it("bloqueia páginas de auth e a API (anti-loop de redirect)", () => {
    expect(parseSafeNext("/login")).toBeNull();
    expect(parseSafeNext("/login?next=/login")).toBeNull();
    expect(parseSafeNext("/signup")).toBeNull();
    expect(parseSafeNext("/forgot-password")).toBeNull();
    expect(parseSafeNext("/auth/callback")).toBeNull();
    expect(parseSafeNext("/api/conversations/open")).toBeNull();
  });

  it("não bloqueia rota que apenas começa com o mesmo texto", () => {
    // `/loginhistory` não é `/login`; o guard casa prefixo de path, não substring.
    expect(parseSafeNext("/logins-report")).toBe("/logins-report");
  });

  it("bloqueia destino acima do teto de tamanho", () => {
    expect(parseSafeNext("/i" + "a".repeat(MAX_NEXT_LENGTH))).toBeNull();
  });

  it("devolve null para entrada vazia ou ausente", () => {
    expect(parseSafeNext(null)).toBeNull();
    expect(parseSafeNext(undefined)).toBeNull();
    expect(parseSafeNext("")).toBeNull();
  });

  it("nunca lança, seja qual for a entrada", () => {
    // Contrato duro: roda no middleware, que é caminho de auth de todo request.
    const entradas = ["%", "%%%", "/%E0%A4%A", "?", "#", " ", "/ ", "\\"];
    for (const e of entradas) {
      expect(() => parseSafeNext(e)).not.toThrow();
    }
  });
});

describe("safeNextOrDefault", () => {
  it("devolve o destino quando válido", () => {
    expect(safeNextOrDefault("/inbox?c=1")).toBe("/inbox?c=1");
  });

  it("cai no fallback quando inválido", () => {
    expect(safeNextOrDefault("//evil.com")).toBe("/dashboard");
    expect(safeNextOrDefault(null)).toBe("/dashboard");
  });

  it("aceita fallback próprio", () => {
    expect(safeNextOrDefault("//evil.com", "/inbox")).toBe("/inbox");
  });
});
