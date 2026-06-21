import type { Contact, QuickReply } from '@/types'

/**
 * Variáveis suportadas no texto da quick reply → campo do contato.
 * Centralizado p/ reuso (helper + futura UI de inserção de variáveis).
 */
export const QUICK_REPLY_VARS = ['name', 'phone', 'email', 'company'] as const
export type QuickReplyVar = (typeof QUICK_REPLY_VARS)[number]

/**
 * Substitui {{name}}/{{phone}}/{{email}}/{{company}} pelos dados do contato.
 * Regex global (todas as ocorrências). Placeholder desconhecido ou campo
 * ausente → string vazia (nunca "undefined"). Mapa próprio — NÃO usa
 * resolveVariables (aquele é numérico e retorna array, incompatível).
 */
export function renderQuickReply(text: string, contact: Contact | null): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey as QuickReplyVar
    if (!contact || !(QUICK_REPLY_VARS as readonly string[]).includes(key)) {
      return ''
    }
    return contact[key] ?? ''
  })
}

/**
 * Filtra a lista pelo termo digitado após o "/", case-insensitive,
 * casando por shortcut OU pelo texto da resposta. Query vazia → tudo.
 */
export function filterQuickReplies(
  list: QuickReply[],
  query: string,
): QuickReply[] {
  const q = query.trim().toLowerCase()
  if (!q) return list
  return list.filter(
    (r) =>
      r.shortcut.toLowerCase().includes(q) ||
      r.message_text.toLowerCase().includes(q),
  )
}
