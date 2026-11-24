// ============================================================
// sales-attribution.ts — regra PURA de atribuição de venda (matrícula MB).
// ⚠️ Usada pelo worker src/lib/reports/sales-cron.ts. Sem I/O aqui.
// Decisões: só status='success'; curso ∈ cursos pagos; data_matricula dentro da
// janela [1º contato, +janela]; atendente HUMANO (a IA é resolvida/excluída pelo
// caller → responsibleUserId já vem null se só houver IA).
// ============================================================
import type { StudentInfoResponse, CursoMatriculado } from "@/lib/integrations/student-info";

export type SaleCandidate = {
  id_curso: number;
  nome_curso: string | null;
  data_matricula: string;
  atendente_id: string | null;   // user_id do humano; null = sem humano (não contado pela RPC)
  confidence: "high" | "low";
};

// Converte a data da MB em Date. A MB manda 'YYYY-MM-DD HH:MM:SS' sem offset,
// no horário de São Paulo (fuso do MySQL dela). O offset precisa ser explícito:
// o container roda em UTC e leria a hora como UTC, deslocando a janela em 3h.
// -03:00 fixo vale porque o Brasil não tem horário de verão. ISO com offset ou
// 'Z' passa direto.
function parseMbDate(s: string): Date {
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  return new Date(hasOffset ? iso : `${iso}-03:00`);
}

// Decide quais matrículas contam como venda atribuível desta conversa.
export function pickAttributableSales(args: {
  payload: StudentInfoResponse;
  paidCourseIds: Set<number>;
  firstContactAt: Date;          // 1ª msg do cliente da conversa
  windowDays: number;
  responsibleUserId: string | null; // responsável humano resolvido (já SEM IA); null = só IA/sem humano
  aiTopicIsVendas: boolean;
}): SaleCandidate[] {
  // C2: ambiguidade (multiplos) / não encontrado → não atribui nada.
  if (args.payload.status !== "success") return [];

  const start = args.firstContactAt.getTime();
  const end = start + args.windowDays * 86_400_000;
  const byId = new Map<number, SaleCandidate>();

  for (const c of (args.payload.cursos_matriculados ?? []) as CursoMatriculado[]) {
    if (!args.paidCourseIds.has(c.id_curso)) continue;        // bundle/grátis fora
    const dm = parseMbDate(c.data_matricula).getTime();
    if (Number.isNaN(dm)) continue;
    if (dm < start || dm > end) continue;                     // fora da janela / antes do 1º contato
    // dedupe por curso (a unique do banco também cobre)
    byId.set(c.id_curso, {
      id_curso: c.id_curso,
      nome_curso: c.nome_curso ?? null,
      data_matricula: c.data_matricula,
      atendente_id: args.responsibleUserId,                   // C1: null se só IA
      confidence: args.aiTopicIsVendas ? "high" : "low",
    });
  }
  return [...byId.values()];
}

// Vendas já confirmadas cujo curso sumiu do retorno da MB e cuja janela ainda
// está aberta → devem ser revertidas. `windowOpen(dm)` = janela ainda válida.
export function detectReversions(
  confirmed: { id_curso: number; data_matricula: string }[],
  payload: StudentInfoResponse,
  windowOpen: (dataMatricula: string) => boolean,
): number[] {
  // sem dado confiável (erro/ambiguidade) → não reverte (evita falso-negativo destrutivo)
  if (payload.status !== "success") return [];
  const present = new Set((payload.cursos_matriculados ?? []).map((c) => c.id_curso));
  return confirmed
    .filter((s) => !present.has(s.id_curso) && windowOpen(s.data_matricula))
    .map((s) => s.id_curso);
}
