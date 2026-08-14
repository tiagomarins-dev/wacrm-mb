// ============================================================
// Formatação dos números do relatório de custo de IA.
// Os valores do OpenRouter são frações de dólar (uma conversa custa ~US$ 0,17
// e um turno ~US$ 0,006), então arredondar tudo em 2 casas transformaria a
// maior parte da tabela em "US$ 0,01" ou "US$ 0,00". A precisão acompanha a
// magnitude: quanto menor o valor, mais casas.
// ============================================================

// Numérico do Postgres chega como string no supabase-js (precisão exata) —
// normaliza antes de qualquer conta. Nulo/lixo vira 0 para não propagar NaN
// para dentro dos cards.
export function toNumber(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

// Formata dólar com casas proporcionais à magnitude: totais do período leem
// como dinheiro (US$ 43,65) e custos de turno seguem legíveis (US$ 0,0059).
export function formatUsd(v: string | number | null | undefined): string {
  const n = toNumber(v)
  const casas = n === 0 ? 2 : Math.abs(n) < 0.01 ? 4 : Math.abs(n) < 1 ? 3 : 2
  return `US$ ${n.toFixed(casas).replace('.', ',')}`
}

// Abrevia contagem de tokens: a tabela mostra milhões por conversa e o número
// cru rouba a largura das colunas que importam.
export function formatTokens(v: string | number | null | undefined): string {
  const n = toNumber(v)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(Math.round(n))
}
