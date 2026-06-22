import { describe, it, expect } from "vitest";
import { formatDate, formatNumber } from "./format";

// Datas/números por locale. Node 20+ tem full-ICU, então pt-BR formata certo.
describe("i18n/format", () => {
  const d = "2026-06-21T12:00:00Z";

  it("formatDate difere entre pt-BR e en", () => {
    const pt = formatDate(d, "pt-BR");
    const en = formatDate(d, "en");
    expect(pt).not.toBe(en);
    expect(pt.toLowerCase()).toContain("jun"); // "21 de jun. de 2026"
    expect(en).toContain("Jun"); // "Jun 21, 2026"
  });

  it("formatNumber usa separadores do locale", () => {
    expect(formatNumber(1234.5, "pt-BR")).toBe("1.234,5");
    expect(formatNumber(1234.5, "en")).toBe("1,234.5"); // en → en-US
  });
});
