import type { SupabaseClient } from '@supabase/supabase-js'

/** Filtro de audiência suportado pelo blueprint webhook (v1). */
export interface BlueprintAudienceFilter {
  type: 'all' | 'tags'
  tagIds?: string[]
  excludeTagIds?: string[]
}

// PostgREST limita o IN(...) — pagina (mesmo racional de
// fetchCustomValueIndex, variables.ts).
const PAGE = 500

// PostgREST devolve no máximo 1000 linhas por resposta — contact_tags de uma
// turma grande passa disso, então os vínculos são lidos em páginas ordenadas.
const TAG_PAGE = 1000

/** contact_ids (com repetição) de quem carrega qualquer uma das tags. */
async function contactIdsByTags(admin: SupabaseClient, tagIds: string[]): Promise<string[]> {
  const ids: string[] = []
  for (let from = 0; ; from += TAG_PAGE) {
    const { data, error } = await admin
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
      .order('id')
      .range(from, from + TAG_PAGE - 1)
    if (error) throw error
    const page = (data ?? []) as { contact_id: string }[]
    for (const r of page) ids.push(r.contact_id)
    if (page.length < TAG_PAGE) break
  }
  return ids
}

/**
 * Resolve a audiência do blueprint NO MOMENTO do disparo, escopada à
 * conta E à conexão do blueprint. O client aqui é service-role (bypassa
 * RLS) — o filtro explícito account_id+connection_id É o isolamento;
 * contatos são por-conexão (migs 022/033) e o engine envia pela conexão
 * do broadcast. Retorna só ids (recipients não precisam de mais).
 */
export async function resolveBlueprintAudience(
  admin: SupabaseClient,
  accountId: string,
  connectionId: string,
  filter: BlueprintAudienceFilter,
): Promise<{ id: string }[]> {
  if (filter.type !== 'all' && filter.type !== 'tags') {
    // custom_field/csv não são suportados no webhook (defesa contra
    // audience_filter editado à mão no banco)
    throw new Error(`unsupported audience type: ${(filter as { type: string }).type}`)
  }

  let contacts: { id: string }[] = []

  if (filter.type === 'all') {
    const { data, error } = await admin
      .from('contacts')
      .select('id')
      .eq('account_id', accountId)
      .eq('connection_id', connectionId)
    if (error) throw error
    contacts = (data ?? []) as { id: string }[]
  } else {
    const tagIds = filter.tagIds ?? []
    if (tagIds.length === 0) return []
    // contact_tags → ids únicos (espelha resolveAudience do hook client)
    const ids = [...new Set(await contactIdsByTags(admin, tagIds))]
    // contacts escopados, paginando o IN
    for (let i = 0; i < ids.length; i += PAGE) {
      const { data, error } = await admin
        .from('contacts')
        .select('id')
        .in('id', ids.slice(i, i + PAGE))
        .eq('account_id', accountId)
        .eq('connection_id', connectionId)
      if (error) throw error
      contacts.push(...((data ?? []) as { id: string }[]))
    }
  }

  // excludeTagIds: remove quem carrega qualquer tag de exclusão
  const exclude = filter.excludeTagIds ?? []
  if (exclude.length > 0 && contacts.length > 0) {
    const excluded = new Set(await contactIdsByTags(admin, exclude))
    contacts = contacts.filter((c) => !excluded.has(c.id))
  }

  return contacts
}
