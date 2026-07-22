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
    const { data: ct, error: ctErr } = await admin
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', tagIds)
    if (ctErr) throw ctErr
    const ids = [...new Set((ct ?? []).map((r) => r.contact_id as string))]
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
    const excluded = new Set<string>()
    const { data: ex, error: exErr } = await admin
      .from('contact_tags')
      .select('contact_id')
      .in('tag_id', exclude)
    if (exErr) throw exErr
    for (const r of ex ?? []) excluded.add(r.contact_id as string)
    contacts = contacts.filter((c) => !excluded.has(c.id))
  }

  return contacts
}
