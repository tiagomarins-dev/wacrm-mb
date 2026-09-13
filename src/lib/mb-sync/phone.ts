// ============================================================
// Telefone da Plataforma MB → chaves de busca no CRM.
// A plataforma grava só dígitos, com ou sem DDI; o CRM grava phone_normalized
// (só dígitos, mig 022) no formato que chegou — inbound com 55, CSV/form às
// vezes sem. Por isso o casamento tenta as variantes de 55 e do 9º dígito,
// NUNCA os últimos 8 dígitos (phonesMatch colide entre DDDs diferentes).
// ============================================================
import { brPhoneNinthDigitVariant, normalizePhone } from '@/lib/whatsapp/phone-utils'

/** 55+DDD+número (12/13 dígitos) ou null quando não parece telefone BR. */
export function toCanonicalBr(raw: string | null | undefined): string | null {
  const d = normalizePhone(raw ?? '')
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) return d
  // 10/11 dígitos = DDD + número sem DDI; DDD nunca começa com 0
  if ((d.length === 10 || d.length === 11) && !d.startsWith('0')) return `55${d}`
  return null
}

/** Chaves em ordem de prioridade: exata → variante 9º dígito → sem 55 → variante sem 55. */
export function phoneKeys(canonical: string): string[] {
  const variant = brPhoneNinthDigitVariant(canonical)
  const keys = [canonical, variant, canonical.slice(2), variant ? variant.slice(2) : null]
  return [...new Set(keys.filter((k): k is string => !!k))]
}
