// ============================================================
// Funde as duas fontes de curso da MB numa lista única por id_curso:
// cursos_matriculados (matrícula/tag) + progresso_aulas.por_curso (aulas/vídeo).
// Antes a sidebar mostrava o mesmo curso 2× (uma por fonte) — aqui juntamos.
// Lógica pura (sem React/DOM). Espelha o padrão de assignee.ts / redacoes.ts.
// ============================================================
import type { CursoMatriculado, ProgressoAulas } from "@/lib/integrations/student-info";

// Progresso de um curso (subconjunto de ProgressoAulas.por_curso, sem id/nome).
export interface ProgressoCurso {
  total_aulas: number;
  aulas_concluidas: number;
  percentual_concluidas: number;
  media_video_assistido: number;
}

// Curso já fundido: dados de matrícula + progresso (null se a fonte não trouxe).
export interface CursoFundido {
  id_curso: number;
  nome_curso: string;
  tag: string;
  data_matricula: string | null;
  progresso: ProgressoCurso | null;
}

// Junta matrícula + progresso por id_curso. Preserva a ordem dos matriculados
// e adiciona ao fim os cursos que só têm progresso (sem matrícula listada).
export function fundeCursos(
  cursos: CursoMatriculado[] | undefined,
  progresso: ProgressoAulas | undefined,
): CursoFundido[] {
  const porCurso = progresso?.por_curso ?? [];
  // Índice de progresso por id_curso para lookup O(1).
  const progIndex = new Map(porCurso.map((p) => [p.id_curso, p]));
  const usados = new Set<number>();
  const fundidos: CursoFundido[] = [];

  // 1) Matriculados na ordem original, anexando o progresso quando houver.
  for (const c of cursos ?? []) {
    const p = progIndex.get(c.id_curso);
    if (p) usados.add(c.id_curso);
    fundidos.push({
      id_curso: c.id_curso,
      nome_curso: c.nome_curso,
      tag: c.tag,
      data_matricula: c.data_matricula || null,
      progresso: p
        ? {
            total_aulas: p.total_aulas,
            aulas_concluidas: p.aulas_concluidas,
            percentual_concluidas: p.percentual_concluidas,
            media_video_assistido: p.media_video_assistido,
          }
        : null,
    });
  }

  // 2) Cursos que só aparecem no progresso (sem matrícula) → adiciona ao fim.
  for (const p of porCurso) {
    if (usados.has(p.id_curso)) continue;
    fundidos.push({
      id_curso: p.id_curso,
      nome_curso: p.nome_curso,
      tag: "",
      data_matricula: null,
      progresso: {
        total_aulas: p.total_aulas,
        aulas_concluidas: p.aulas_concluidas,
        percentual_concluidas: p.percentual_concluidas,
        media_video_assistido: p.media_video_assistido,
      },
    });
  }

  return fundidos;
}

// Grupo de cursos de um mesmo ano de matrícula (null = sem data).
export interface CursosPorAno {
  ano: number | null;
  cursos: CursoFundido[];
}

// Agrupa os cursos fundidos por ano da matrícula (data_matricula). O ano vem
// dos 4 primeiros dígitos ("2026-05-29..." → 2026); sem data → null. Ordena por
// ano desc; o grupo sem-ano (null) fica por último. Pura — o accordion consome
// no componente.
export function agrupaCursosPorAno(cursos: CursoFundido[]): CursosPorAno[] {
  const porAno = new Map<number | null, CursoFundido[]>();
  for (const c of cursos) {
    // Extrai o ano do início da data (evita parse com timezone).
    const ano = Number(c.data_matricula?.slice(0, 4)) || null;
    const lista = porAno.get(ano);
    if (lista) lista.push(c);
    else porAno.set(ano, [c]);
  }
  // Ano desc; grupo "sem ano" (null) sempre por último.
  return [...porAno.entries()]
    .map(([ano, cursos]) => ({ ano, cursos }))
    .sort((a, b) => {
      if (a.ano === null) return 1;
      if (b.ano === null) return -1;
      return b.ano - a.ano;
    });
}
