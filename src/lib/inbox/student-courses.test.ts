import { describe, expect, it } from "vitest";
import { fundeCursos } from "./student-courses";
import type { CursoMatriculado, ProgressoAulas } from "@/lib/integrations/student-info";

const curso = (id: number, nome: string, tag = "curso"): CursoMatriculado => ({
  id_curso: id, nome_curso: nome, tag, data_matricula: "2026-05-29 10:00:00",
});
const pc = (id: number, nome: string, feitas: number, total: number) => ({
  id_curso: id, nome_curso: nome, total_aulas: total, aulas_concluidas: feitas,
  percentual_concluidas: total ? (feitas / total) * 100 : 0, media_video_assistido: 80,
});
const prog = (itens: ProgressoAulas["por_curso"]): ProgressoAulas => ({
  percentual_geral: 32, por_curso: itens,
});

describe("fundeCursos", () => {
  it("matrícula + progresso do mesmo curso → um único item com ambos", () => {
    const r = fundeCursos([curso(1, "UERJ 2026")], prog([pc(1, "UERJ 2026", 17, 38)]));
    expect(r).toHaveLength(1);
    expect(r[0].id_curso).toBe(1);
    expect(r[0].data_matricula).toBe("2026-05-29 10:00:00");
    expect(r[0].progresso?.aulas_concluidas).toBe(17);
  });

  it("curso matriculado sem progresso → progresso null", () => {
    const r = fundeCursos([curso(2, "Clube do Livro")], prog([]));
    expect(r).toHaveLength(1);
    expect(r[0].progresso).toBeNull();
    expect(r[0].data_matricula).not.toBeNull();
  });

  it("curso só no progresso (sem matrícula) → aparece ao fim, matrícula null", () => {
    const r = fundeCursos([curso(1, "UERJ")], prog([pc(1, "UERJ", 1, 2), pc(9, "Extra", 3, 3)]));
    expect(r.map((c) => c.id_curso)).toEqual([1, 9]);
    expect(r[1].data_matricula).toBeNull();
    expect(r[1].tag).toBe("");
    expect(r[1].progresso?.total_aulas).toBe(3);
  });

  it("preserva a ordem dos matriculados", () => {
    const r = fundeCursos([curso(3, "C"), curso(1, "A"), curso(2, "B")], prog([]));
    expect(r.map((c) => c.id_curso)).toEqual([3, 1, 2]);
  });

  it("sem duplicata: curso em ambas as fontes aparece uma vez só", () => {
    const r = fundeCursos([curso(1, "X"), curso(2, "Y")], prog([pc(1, "X", 1, 2), pc(2, "Y", 0, 5)]));
    expect(r).toHaveLength(2);
  });

  it("cursos undefined + progresso undefined → []", () => {
    expect(fundeCursos(undefined, undefined)).toEqual([]);
  });

  it("data_matricula vazia → null", () => {
    const c = { ...curso(1, "X"), data_matricula: "" };
    expect(fundeCursos([c], undefined)[0].data_matricula).toBeNull();
  });
});
