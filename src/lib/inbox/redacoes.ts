// ============================================================
// Agrega as redações do aluno por banca para um ano específico. Lógica pura
// (sem React/DOM) — a MB devolve por_ano_banca; aqui filtramos o ano corrente
// e somamos por nome_banca. Blindado contra payload sujo (banca vazia, total
// como string). Espelha o padrão de assignee.ts / queue.ts.
// ============================================================
import type { Redacoes } from "@/lib/integrations/student-info";

// Devolve [banca, total][] do ano dado, ordenado por total desc
// (desempate alfabético). Vazio → []. redacoes ausente → [] (não lança).
export function agrupaRedacoesPorBanca(
  redacoes: Redacoes | undefined,
  ano: number,
): [string, number][] {
  const linhas = (redacoes?.por_ano_banca ?? []).filter((r) => r.ano === ano);
  // Soma por nome_banca — protege contra linhas repetidas da mesma banca no ano.
  const porBanca = new Map<string, number>();
  for (const r of linhas) {
    const banca = (r.nome_banca ?? "").trim();
    if (!banca) continue; // ignora banca vazia/nula (payload sujo da MB)
    porBanca.set(banca, (porBanca.get(banca) ?? 0) + (Number(r.total) || 0));
  }
  return [...porBanca.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
}
