import { describe, expect, it } from "vitest";
import { connectionLabel } from "./label";

describe("connectionLabel — cadeia de fallback", () => {
  it("usa o label quando preenchido", () => {
    expect(
      connectionLabel({ label: "Vendas", phone_number_id: "12345" }),
    ).toBe("Vendas");
  });

  it("label só-espaços cai no phone_number_id", () => {
    expect(
      connectionLabel({ label: "   ", phone_number_id: "12345" }),
    ).toBe("12345");
  });

  it("faz trim do label", () => {
    expect(connectionLabel({ label: "  Suporte  " })).toBe("Suporte");
  });

  it("label null + phone → phone", () => {
    expect(
      connectionLabel({ label: null, phone_number_id: "55999" }),
    ).toBe("55999");
  });

  it("só instance_name (Evolution) → instance_name", () => {
    expect(
      connectionLabel({ phone_number_id: null, instance_name: "turma-2026" }),
    ).toBe("turma-2026");
  });

  it("tudo vazio/null → 'Conexão'", () => {
    expect(
      connectionLabel({ label: null, phone_number_id: null, instance_name: null }),
    ).toBe("Conexão");
    expect(connectionLabel({})).toBe("Conexão");
  });
});
