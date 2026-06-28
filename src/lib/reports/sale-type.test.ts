import { describe, expect, it } from "vitest";
import { classifySaleType } from "./sale-type";

describe("classifySaleType", () => {
  it("1ª msg do atendente (humano) → ativa", () => {
    expect(classifySaleType("agent")).toBe("ativa");
  });
  it("1ª msg do cliente → passiva", () => {
    expect(classifySaleType("customer")).toBe("passiva");
  });
  it("1ª msg do bot (automação/IA) → passiva", () => {
    expect(classifySaleType("bot")).toBe("passiva");
  });
  it("sem mensagens → null", () => {
    expect(classifySaleType(null)).toBeNull();
  });
});
