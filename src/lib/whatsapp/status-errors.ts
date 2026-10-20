// ============================================================
// Motivo da falha de entrega devolvido pela Meta no recibo de status
// ('failed'). O webhook grava o mesmo texto em messages e em
// broadcast_recipients; o código vai à parte em messages.error_code para
// dar para agrupar as falhas por causa.
// ============================================================

/** Item de errors[] do recibo de status da Meta. */
export interface MetaStatusError {
  code?: number
  title?: string
  message?: string
  error_data?: { details?: string }
}

const MAX_ERROR_MESSAGE = 500

// Junta código, título, mensagem e detalhe de cada erro ("131049 — título — ...")
// e corta no tamanho que as colunas de texto aceitam sem virar payload.
export function formatStatusErrors(errors: MetaStatusError[] | undefined): string | null {
  if (!errors?.length) return null
  const texto = errors
    .map((e) => [e.code, e.title, e.message, e.error_data?.details].filter(Boolean).join(' — '))
    .filter(Boolean)
    .join(' | ')
    .slice(0, MAX_ERROR_MESSAGE)
  return texto || null
}

// Código numérico do primeiro erro; null quando a Meta não mandou um inteiro.
export function firstStatusErrorCode(errors: MetaStatusError[] | undefined): number | null {
  const code = errors?.[0]?.code
  return Number.isInteger(code) ? (code as number) : null
}
