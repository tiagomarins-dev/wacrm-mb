// DDDs em uso no Brasil (Anatel). Primeiro filtro para reconhecer um celular
// ou fixo brasileiro gravado sem o código do país.
const DDDS_BR = new Set([
  '11', '12', '13', '14', '15', '16', '17', '18', '19', '21', '22', '24', '27', '28',
  '31', '32', '33', '34', '35', '37', '38', '41', '42', '43', '44', '45', '46', '47',
  '48', '49', '51', '53', '54', '55', '61', '62', '63', '64', '65', '66', '67', '68',
  '69', '71', '73', '74', '75', '77', '79', '81', '82', '83', '84', '85', '86', '87',
  '88', '89', '91', '92', '93', '94', '95', '96', '97', '98', '99',
])

/**
 * Acrescenta o 55 a um telefone brasileiro digitado sem o código do país
 * (contato criado à mão ou por planilha). Sem o 55, a Meta trata o número como
 * de outro país e o template de primeiro contato falha.
 *
 * Reconhece como brasileiro, só com dígitos:
 *  - 11 dígitos: DDD válido + celular começando em 9 (ex.: 15 99130 6578);
 *  - 10 dígitos: DDD válido + fixo ou celular antigo de 8 dígitos (2–9).
 * Número estrangeiro com DDI de 1 dígito não cai na regra: o código de área
 * dos EUA/Canadá nunca tem 9 no meio ("1X9…") e o exemplo lituano "370 6…" tem
 * 0 na terceira posição. Fica o risco residual de um número estrangeiro sem
 * DDI que imite esse formato, raro no WhatsApp.
 * Qualquer outra entrada volta igual.
 */
export function addBrazilCountryCode(digits: string): string {
  if (!/^\d{10,11}$/.test(digits) || !DDDS_BR.has(digits.slice(0, 2))) return digits
  const terceiro = digits[2]
  if (digits.length === 11 && terceiro !== '9') return digits
  if (digits.length === 10 && !/[2-9]/.test(terceiro)) return digits
  return `55${digits}`
}

/**
 * Telefone para gravar no contato: com o 55 quando é um número brasileiro
 * digitado sem ele (só dígitos, para casar com phone_normalized); senão o
 * texto como foi digitado, sem espaços nas pontas. Número digitado com "+"
 * já traz o código do país e nunca é alterado (ex.: "+51 997 597 024").
 */
export function withBrazilCountryCode(phone: string): string {
  const texto = (phone ?? '').trim()
  if (texto.startsWith('+')) return texto
  const digits = texto.replace(/\D/g, '')
  const corrigido = addBrazilCountryCode(digits)
  return corrigido !== digits ? corrigido : texto
}

/**
 * Sanitize phone number for Meta WhatsApp API.
 * Meta requires digits only — no + prefix, no spaces, no dashes.
 * e.g. "+370 63949836" → "37063949836"
 * Não completa o 55: o telefone de quem escreveu é o wa_id da Meta, já com o
 * código do país, e um número estrangeiro com o formato de um brasileiro sem
 * 55 (ex.: celular do Peru 51 9xxxxxxxx) iria para outra pessoa. O 55 entra
 * só quando o atendente cadastra o contato (withBrazilCountryCode).
 */
export function sanitizePhoneForMeta(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Normalize phone number by removing all non-digit characters.
 * Used for comparing phone numbers in different formats.
 */
export function normalizePhone(phone: string): string {
  if (!phone) return ''
  return phone.replace(/\D/g, '')
}

/**
 * Compare two phone numbers accounting for trunk prefix differences.
 * e.g. "370063949836" (with trunk 0) matches "37063949836" (without trunk 0)
 * by comparing the last 8 digits.
 */
export function phonesMatch(phone1: string, phone2: string): boolean {
  const n1 = normalizePhone(phone1)
  const n2 = normalizePhone(phone2)
  if (n1 === n2) return true
  if (n1.length >= 8 && n2.length >= 8) {
    return n1.slice(-8) === n2.slice(-8)
  }
  return false
}

/**
 * Variante do 9º dígito p/ celular BR (55 + DDD + 8/9 dígitos): cadastros antigos
 * na base MB podem não ter o 9 (ou o inverso), quebrando o match por telefone.
 * 55+DDD+9 dígitos começando em 9 → remove o 9; 55+DDD+8 dígitos → insere o 9.
 * Não-BR ou shape inesperado → null (sem variante).
 */
export function brPhoneNinthDigitVariant(digits: string): string | null {
  if (!/^55\d{10,11}$/.test(digits)) return null
  const ddd = digits.slice(2, 4)
  const rest = digits.slice(4)
  if (rest.length === 9 && rest.startsWith('9')) return `55${ddd}${rest.slice(1)}`
  if (rest.length === 8) return `55${ddd}9${rest}`
  return null
}

/**
 * Validate phone number is E.164-like format (7-15 digits starting with non-zero).
 * Accepts with or without + prefix.
 */
export function isValidE164(phone: string): boolean {
  return /^\+?[1-9]\d{6,14}$/.test(phone)
}

/**
 * Generate plausible phone number variants for retry when Meta's
 * sandbox rejects a number with error #131030 ("not in allowed list").
 *
 * Many countries use a "trunk prefix" 0 for domestic dialing that is
 * meant to be dropped in international format (e.g. Lithuanian
 * "+370 063 949 836" domestically → "+370 63 949 836" international).
 * But some sandboxes register the number with the trunk 0 included,
 * causing sends to the correct international format to fail.
 *
 * This helper yields up to 3 variants:
 *   1. The original sanitized number (first attempt)
 *   2. With a trunk 0 inserted after the country code
 *   3. With a trunk 0 removed after the country code
 *
 * Country-code lengths of 1, 2, and 3 digits are tried because we
 * don't know the user's country ahead of time.
 *
 * @param sanitized - digits-only phone number (from sanitizePhoneForMeta)
 * @returns deduplicated list of variants, original first
 */
export function phoneVariants(sanitized: string): string[] {
  if (!sanitized) return []
  const seen = new Set<string>()
  const push = (v: string) => {
    if (v && !seen.has(v)) seen.add(v)
  }

  // 1. Original
  push(sanitized)

  // 2. Insert a 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (!rest.startsWith('0')) {
      push(cc + '0' + rest)
    }
  }

  // 3. Remove a leading 0 after each plausible country-code length
  for (const ccLen of [1, 2, 3]) {
    if (sanitized.length <= ccLen + 1) continue
    const cc = sanitized.slice(0, ccLen)
    const rest = sanitized.slice(ccLen)
    if (rest.startsWith('0')) {
      push(cc + rest.slice(1))
    }
  }

  return [...seen]
}

/**
 * Returns true when the Meta API error indicates the recipient
 * phone number isn't in the allowed list (sandbox restriction).
 * Detected via error code 131030 or the standard error text.
 */
export function isRecipientNotAllowedError(message: string): boolean {
  return /131030|not in allowed list|not in the allowed list/i.test(message)
}
