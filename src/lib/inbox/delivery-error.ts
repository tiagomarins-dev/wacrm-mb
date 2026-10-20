// ============================================================
// Tradução do código de falha da Meta para uma explicação que o atendente
// entende (faixa vermelha da conversa e ícone da mensagem). Só os códigos
// que aparecem no envio de template e de mensagem comum; o resto cai no
// texto genérico com o código e o título que a Meta mandou.
// ============================================================

// Códigos com explicação própria no dicionário inbox (deliveryError.<código>).
const CODIGOS_CONHECIDOS = new Set([131049, 131026, 131047, 131050, 131000, 131021, 131008])

/** Chave i18n da explicação, ou null quando o código não tem texto próprio. */
export function deliveryErrorKey(code: number | null | undefined): string | null {
  return code != null && CODIGOS_CONHECIDOS.has(code) ? `deliveryError.${code}` : null
}

// Título da Meta (2º trecho de error_message) para o texto genérico, quando o
// código não é conhecido. error_message vem de formatStatusErrors.
export function deliveryErrorTitle(errorMessage: string | null | undefined): string | null {
  const partes = (errorMessage ?? '').split(' | ')[0].split(' — ')
  return partes[1]?.trim() || partes[0]?.trim() || null
}

// Explicação da falha para o atendente: texto próprio para os códigos
// conhecidos, senão "código N: título da Meta".
export function describeDeliveryError(
  t: (key: string, opts?: Record<string, unknown>) => string,
  message: { error_code?: number | null; error_message?: string | null },
): string {
  const key = deliveryErrorKey(message.error_code)
  if (key) return t(key)
  return t('deliveryErrorGeneric', {
    code: message.error_code ?? '?',
    title: deliveryErrorTitle(message.error_message) ?? '',
  })
}
