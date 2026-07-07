import { describe, expect, it } from "vitest";
import { agrupaRedacoesPorBanca } from "./redacoes";
import type { Redacoes } from "@/lib/integrations/student-info";

// Monta um Redacoes só com por_ano_banca (total histórico irrelevante aqui).
const mk = (linhas: Redacoes["por_ano_banca"]): Redacoes => ({ total: 0, por_ano_banca: linhas });

describe("agrupaRedacoesPorBanca", () => {
  it("bancas distintas no ano → ordenado por total desc", () => {
    const r = mk([
      { ano: 2026, id_banca: 1, nome_banca: "UERJ", total: 8 },
      { ano: 2026, id_banca: 2, nome_banca: "ENEM", total: 12 },
    ]);
    expect(agrupaRedacoesPorBanca(r, 2026)).toEqual([["ENEM", 12], ["UERJ", 8]]);
  });

  it("duas linhas da mesma banca no ano → soma", () => {
    const r = mk([
      { ano: 2026, id_banca: 2, nome_banca: "ENEM", total: 5 },
      { ano: 2026, id_banca: 2, nome_banca: "ENEM", total: 7 },
    ]);
    expect(agrupaRedacoesPorBanca(r, 2026)).toEqual([["ENEM", 12]]);
  });

  it("linha de ano anterior é descartada", () => {
    const r = mk([
      { ano: 2025, id_banca: 2, nome_banca: "ENEM", total: 99 },
      { ano: 2026, id_banca: 2, nome_banca: "ENEM", total: 3 },
    ]);
    expect(agrupaRedacoesPorBanca(r, 2026)).toEqual([["ENEM", 3]]);
  });

  it("sem registro do ano → []", () => {
    const r = mk([{ ano: 2024, id_banca: 2, nome_banca: "ENEM", total: 4 }]);
    expect(agrupaRedacoesPorBanca(r, 2026)).toEqual([]);
  });

  it("redacoes undefined → [] (não lança)", () => {
    expect(agrupaRedacoesPorBanca(undefined, 2026)).toEqual([]);
  });

  it("nome_banca vazio/espaço é ignorado", () => {
    const r = mk([
      { ano: 2026, id_banca: 0, nome_banca: "   ", total: 5 },
      { ano: 2026, id_banca: 2, nome_banca: "ENEM", total: 2 },
    ]);
    expect(agrupaRedacoesPorBanca(r, 2026)).toEqual([["ENEM", 2]]);
  });

  it("total como string numérica é coagido", () => {
    const r = mk([{ ano: 2026, id_banca: 2, nome_banca: "ENEM", total: "9" as unknown as number }]);
    expect(agrupaRedacoesPorBanca(r, 2026)).toEqual([["ENEM", 9]]);
  });

  it("empate de total → desempate alfabético", () => {
    const r = mk([
      { ano: 2026, id_banca: 3, nome_banca: "FUVEST", total: 4 },
      { ano: 2026, id_banca: 2, nome_banca: "ENEM", total: 4 },
    ]);
    expect(agrupaRedacoesPorBanca(r, 2026)).toEqual([["ENEM", 4], ["FUVEST", 4]]);
  });
});
