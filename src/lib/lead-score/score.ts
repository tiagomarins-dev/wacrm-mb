// ============================================================
// Fórmula do Lead Score — pura e testável. É a REFERÊNCIA da pontuação;
// a RPC `lead_scores` (migration 031) espelha exatamente esta aritmética.
// ⚠️ Mudou aqui? Mude na RPC também (e vice-versa).
// ============================================================

export interface ScoreWeights {
  msg: number;
  button: number;
  link: number;
  /** Multiplicador do link de venda (ex: 2 → vale 2x). */
  saleMultiplier: number;
}

export interface ScoreCounts {
  msgs: number;
  buttons: number;
  /** Total de cliques na janela (inclui os de venda). */
  links: number;
  /** Subconjunto de `links` marcado como venda (is_sale). */
  sales: number;
}

// Defaults = os mesmos do migration 031 (lead_score_config).
export const DEFAULT_WEIGHTS: ScoreWeights = { msg: 1, button: 3, link: 5, saleMultiplier: 2 };

// Pontuação ponderada. Link de venda vale round(link*multiplier); link
// normal vale `link`. Mensagem = inbound não-interativo; botão = toque
// em botão/lista (contados separadamente, sem dupla contagem).
export function computeScore(c: ScoreCounts, w: ScoreWeights = DEFAULT_WEIGHTS): number {
  const saleUnit = Math.round(w.link * w.saleMultiplier);
  return (
    c.msgs * w.msg +
    c.buttons * w.button +
    (c.links - c.sales) * w.link +
    c.sales * saleUnit
  );
}

export type LeadClass = 'quente' | 'morno' | 'frio';

// Classifica pelo score e limiares (espera hot > warm).
export function classify(score: number, hot: number, warm: number): LeadClass {
  if (score >= hot) return 'quente';
  if (score >= warm) return 'morno';
  return 'frio';
}
