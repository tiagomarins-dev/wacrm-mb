// ============================================================
// Título de exibição de uma conversa no inbox (058). Grupo (@g.us) não
// tem contato: mostra o nome do grupo se houver, senão "Grupo" + sufixo
// do chat_id (p/ distinguir grupos). 1:1 usa nome/telefone do contato.
// (Nome do grupo persistido é fase futura — group_name.)
// ============================================================
import type { Conversation } from '@/types'

export function conversationTitle(
  conv: Pick<Conversation, 'is_group' | 'chat_id' | 'contact'>,
  groupName?: string | null,
): string {
  if (conv.is_group) {
    if (groupName?.trim()) return groupName.trim()
    // Sufixo curto do JID p/ diferenciar grupos sem nome persistido.
    const suffix = (conv.chat_id ?? '').split('@')[0].slice(-4)
    return suffix ? `Grupo ${suffix}` : 'Grupo'
  }
  return conv.contact?.name || conv.contact?.phone || 'Desconhecido'
}
