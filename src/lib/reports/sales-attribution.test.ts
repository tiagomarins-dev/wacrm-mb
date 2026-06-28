import { describe, expect, it } from "vitest";
import { pickAttributableSales, detectReversions } from "./sales-attribution";
import type { StudentInfoResponse } from "@/lib/integrations/student-info";

const FIRST = new Date("2026-06-01T10:00:00-03:00");
const PAID = new Set([101, 102]);

// payload de sucesso com os cursos dados
function ok(cursos: { id_curso: number; data_matricula: string; nome_curso?: string }[]): StudentInfoResponse {
  return {
    status: "success",
    cursos_matriculados: cursos.map((c) => ({ id_curso: c.id_curso, nome_curso: c.nome_curso ?? "Curso", tag: "", data_matricula: c.data_matricula })),
  };
}

describe("pickAttributableSales", () => {
  const base = { paidCourseIds: PAID, firstContactAt: FIRST, windowDays: 30, responsibleUserId: "u1", aiTopicIsVendas: true };

  it("happy: curso pago + matrícula na janela + ai_topic=vendas → 1 venda high", () => {
    const r = pickAttributableSales({ ...base, payload: ok([{ id_curso: 101, data_matricula: "2026-06-05 14:00:00" }]) });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id_curso: 101, atendente_id: "u1", confidence: "high" });
  });

  it("sem ai_topic=vendas → confidence low", () => {
    const r = pickAttributableSales({ ...base, aiTopicIsVendas: false, payload: ok([{ id_curso: 101, data_matricula: "2026-06-05 14:00:00" }]) });
    expect(r[0].confidence).toBe("low");
  });

  it("curso fora da lista de pagos (bundle) → não conta", () => {
    const r = pickAttributableSales({ ...base, payload: ok([{ id_curso: 999, data_matricula: "2026-06-05 14:00:00" }]) });
    expect(r).toHaveLength(0);
  });

  it("matrícula antes do 1º contato → não conta", () => {
    const r = pickAttributableSales({ ...base, payload: ok([{ id_curso: 101, data_matricula: "2026-05-20 09:00:00" }]) });
    expect(r).toHaveLength(0);
  });

  it("matrícula fora da janela (+31d) → não conta", () => {
    const r = pickAttributableSales({ ...base, payload: ok([{ id_curso: 101, data_matricula: "2026-07-05 09:00:00" }]) });
    expect(r).toHaveLength(0);
  });

  it("borda: 1º contato (inclusivo) conta", () => {
    const r = pickAttributableSales({ ...base, payload: ok([{ id_curso: 101, data_matricula: "2026-06-01 10:00:00" }]) });
    expect(r).toHaveLength(1);
  });

  it("status='multiplos' → [] (ambiguidade não atribui)", () => {
    const r = pickAttributableSales({ ...base, payload: { status: "multiplos", candidatos: [] } });
    expect(r).toHaveLength(0);
  });

  it("status='nao_encontrado' → []", () => {
    const r = pickAttributableSales({ ...base, payload: { status: "nao_encontrado" } });
    expect(r).toHaveLength(0);
  });

  it("responsibleUserId null (só IA) → candidato com atendente null", () => {
    const r = pickAttributableSales({ ...base, responsibleUserId: null, payload: ok([{ id_curso: 101, data_matricula: "2026-06-05 14:00:00" }]) });
    expect(r).toHaveLength(1);
    expect(r[0].atendente_id).toBeNull();
  });

  it("dedupe por id_curso (mesmo curso 2x) → 1", () => {
    const r = pickAttributableSales({ ...base, payload: ok([
      { id_curso: 101, data_matricula: "2026-06-05 14:00:00" },
      { id_curso: 101, data_matricula: "2026-06-06 14:00:00" },
    ]) });
    expect(r).toHaveLength(1);
  });
});

describe("detectReversions", () => {
  const confirmed = [{ id_curso: 101, data_matricula: "2026-06-05 14:00:00" }];
  it("curso sumiu do retorno + janela aberta → reverter", () => {
    expect(detectReversions(confirmed, ok([{ id_curso: 102, data_matricula: "2026-06-05" }]), () => true)).toEqual([101]);
  });
  it("curso ainda presente → não reverte", () => {
    expect(detectReversions(confirmed, ok([{ id_curso: 101, data_matricula: "2026-06-05" }]), () => true)).toEqual([]);
  });
  it("janela fechada → não reverte (congelado)", () => {
    expect(detectReversions(confirmed, ok([]), () => false)).toEqual([]);
  });
  it("payload != success → não reverte (sem dado confiável)", () => {
    expect(detectReversions(confirmed, { status: "nao_encontrado" }, () => true)).toEqual([]);
  });
});
