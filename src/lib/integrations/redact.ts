/**
 * Mascara PII em texto livre antes de mandar pro LLM (defense-in-depth —
 * cliente às vezes digita o próprio email/telefone no chat). Email vira
 * `a***@dominio.com`; sequências de telefone viram `[telefone]`. Texto sem
 * PII fica inalterado.
 */
export function redactPII(text: string): string {
  return text
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      (m) => {
        const [user, domain] = m.split('@')
        return `${user[0] ?? ''}***@${domain}`
      },
    )
    // Telefones: 8+ dígitos, com separadores comuns ( ()-. e espaço ),
    // opcionalmente com +. Evita mascarar números curtos (ex: "2 itens").
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[telefone]')
}
