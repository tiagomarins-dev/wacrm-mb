import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveImportTagIds,
  assignImportedContactTags,
} from '@/lib/contacts/resolve-import-tags'

/**
 * Marca com a tag do disparo os contatos que REALMENTE receberam a mensagem.
 *
 * Compartilhada pelos dois caminhos de envio — o assistente (envio imediato) e
 * o cron de agendamento — para os dois marcarem igual. Reusa o par de funções
 * da importação de contatos: resolve o nome para id, criando a tag se faltar, e
 * insere em contact_tags ignorando duplicados (reenvio não duplica vínculo).
 *
 * Quem falhou no envio NÃO entra: a tag responde "com quem falamos", e template
 * que não chegou não é contato feito.
 *
 * Nunca lança. Nos dois chamadores as mensagens já saíram quando isto roda, e
 * derrubar um disparo concluído por causa da marcação seria pior que perdê-la.
 * Devolve quantos vínculos foram pedidos (0 quando não havia o que marcar).
 */
export async function tagBroadcastRecipients(
  supabase: SupabaseClient,
  params: {
    tagName: string | null | undefined
    contactIds: string[]
    accountId: string
    userId: string
    /** Só admin+ cria tag nova; abaixo disso, usa apenas tag existente. */
    canCreateTags: boolean
  },
): Promise<number> {
  const nome = params.tagName?.trim()
  if (!nome || params.contactIds.length === 0) return 0

  try {
    const { tagIdByKey } = await resolveImportTagIds(supabase, {
      accountId: params.accountId,
      userId: params.userId,
      tagNames: [nome],
      canCreateTags: params.canCreateTags,
    })
    // Sem id resolvido = tag inexistente e sem permissão para criar.
    if (tagIdByKey.size === 0) return 0

    // Dedup: o mesmo contato pode aparecer duas vezes num reenvio parcial.
    const unicos = [...new Set(params.contactIds)]
    return await assignImportedContactTags(
      supabase,
      unicos.map((contactId) => ({ contactId, tagNames: [nome] })),
      tagIdByKey,
    )
  } catch (err) {
    console.error('[broadcast] falha ao marcar a tag do disparo:', err)
    return 0
  }
}
