import type { Contact } from '@/types'

/**
 * Monta o bloco de dados do contato (determinístico, server-side) que é
 * ANEXADO ao resumo da IA antes de enviar pro Notion/Slack. A PII real
 * (email/telefone) entra só aqui — nunca vai pro LLM. Sem alucinação.
 */
export function buildContactBlock(
  contact: Contact | null,
  conversationUrl?: string | null,
): string {
  if (!contact) return ''
  const lines = [
    `Nome: ${contact.name || '—'}`,
    `Telefone: ${contact.phone || '—'}`,
    contact.email ? `Email: ${contact.email}` : null,
    contact.company ? `Empresa: ${contact.company}` : null,
    conversationUrl ? `Conversa: ${conversationUrl}` : null,
  ].filter((l): l is string => Boolean(l))
  return lines.join('\n')
}
