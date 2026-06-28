import { describe, expect, it } from "vitest";
import { parseIntent } from "./openrouter";

describe("parseIntent", () => {
  it("'vendas' → vendas", () => expect(parseIntent("vendas")).toBe("vendas"));
  it("'Suporte.' → suporte (case/pontuação)", () => expect(parseIntent("Suporte.")).toBe("suporte"));
  it("'outro' → outro", () => expect(parseIntent("outro")).toBe("outro"));
  it("fora do enum ('marketing') → null", () => expect(parseIntent("marketing")).toBeNull());
  it("vazio/undefined → null", () => {
    expect(parseIntent("")).toBeNull();
    expect(parseIntent(undefined)).toBeNull();
  });
});
