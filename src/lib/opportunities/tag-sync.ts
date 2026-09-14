// ============================================================
// tag-sync.ts — mantém a tag 'oportunidade' em quem aparece na tela
// Oportunidades e a remove só de quem comprou o curso do sinal (quem apenas
// saiu da janela de 30 dias fica com a tag). Roda depois do mb-sync, que
// atualiza as tags de matriculado usadas para saber quem comprou.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveSupportConfig, SupportConnectionError } from '@/lib/connections/support'
import { resolveImportTagIds } from '@/lib/contacts/resolve-import-tags'

export const OPPORTUNITY_TAG = 'oportunidade'
const PAGE = 1000          // teto de linhas do PostgREST
const UPSERT_CHUNK = 100   // mesmo lote de resolve-import-tags.ts
const PURCHASE_CHUNK = 200

export interface OpportunityTagResult {
  account_id: string
  candidates: number
  tagged: number
  untagged: number
  aborted: string | null
}

// Todos os contact_id da lista (source 'all', todas as conexões), paginados.
async function loadCandidates(db: SupabaseClient, accountId: string): Promise<string[]> {
  const ids: string[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .rpc('opportunities_for_account', { p_account_id: accountId, p_source: 'all', p_connection_id: null })
      .select('contact_id')
      .order('contact_id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error('opportunities_for_account failed')
    const page = (data ?? []) as { contact_id: string }[]
    for (const r of page) ids.push(r.contact_id)
    if (page.length < PAGE) break
  }
  return [...new Set(ids)]
}

// Todos os membros atuais da tag, carregados ANTES de qualquer remoção
// (apagar durante a paginação deslocaria o offset).
async function loadTagMembers(db: SupabaseClient, tagId: string): Promise<string[]> {
  const ids: string[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contact_tags')
      .select('contact_id')
      .eq('tag_id', tagId)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error('contact_tags load failed')
    const page = (data ?? []) as { contact_id: string }[]
    for (const r of page) ids.push(r.contact_id)
    if (page.length < PAGE) break
  }
  return ids
}

// Sincroniza uma conta. dry: conta sem gravar nada (nem cria a tag).
async function syncAccount(db: SupabaseClient, accountId: string, dry: boolean): Promise<OpportunityTagResult> {
  const result: OpportunityTagResult = { account_id: accountId, candidates: 0, tagged: 0, untagged: 0, aborted: null }

  // dono da tag (tags.user_id é NOT NULL): dono da conexão de Suporte, como no mb-sync
  let userId: string
  try {
    userId = (await resolveSupportConfig(db, accountId)).user_id
  } catch (err) {
    if (err instanceof SupportConnectionError) return { ...result, aborted: `support_${err.reason}` }
    throw err
  }

  const candidates = await loadCandidates(db, accountId)
  result.candidates = candidates.length

  const { tagIdByKey } = await resolveImportTagIds(db, {
    accountId,
    userId,
    tagNames: [OPPORTUNITY_TAG],
    canCreateTags: !dry,
  })
  const tagId = tagIdByKey.get(OPPORTUNITY_TAG)
  if (!tagId) {
    // só acontece em dry com a tag ainda inexistente
    return { ...result, tagged: candidates.length }
  }

  // tag controlada pelo mb-sync seria esvaziada a cada hora: não mexe
  const { data: mapped } = await db.from('mb_class_sync').select('id').eq('tag_id', tagId).limit(1)
  if ((mapped ?? []).length > 0) return { ...result, aborted: 'tag_mapped_in_mb_sync' }

  const members = await loadTagMembers(db, tagId)
  const memberSet = new Set(members)
  const toTag = candidates.filter((id) => !memberSet.has(id))
  result.tagged = toTag.length

  // remoção: só quem comprou o curso do último sinal (sem janela)
  const purchased: string[] = []
  for (let i = 0; i < members.length; i += PURCHASE_CHUNK) {
    const { data, error } = await db.rpc('opportunity_purchased', {
      p_account_id: accountId,
      p_contact_ids: members.slice(i, i + PURCHASE_CHUNK),
    })
    if (error) throw new Error('opportunity_purchased failed')
    for (const r of (data ?? []) as { contact_id: string }[]) purchased.push(r.contact_id)
  }
  result.untagged = purchased.length
  if (dry) return result

  for (let i = 0; i < toTag.length; i += UPSERT_CHUNK) {
    const rows = toTag.slice(i, i + UPSERT_CHUNK).map((contact_id) => ({ contact_id, tag_id: tagId }))
    const { error } = await db.from('contact_tags').upsert(rows, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    if (error) throw new Error('contact_tags upsert failed')
  }
  for (let i = 0; i < purchased.length; i += PURCHASE_CHUNK) {
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('tag_id', tagId)
      .in('contact_id', purchased.slice(i, i + PURCHASE_CHUNK))
    if (error) throw new Error('contact_tags delete failed')
  }
  return result
}

/** Entrada do cron: contas com produtos de checkout cadastrados. Só contagens. */
export async function runOpportunityTagSync({ dry }: { dry: boolean }): Promise<{ accounts: OpportunityTagResult[] }> {
  const db = supabaseAdmin()
  const { data, error } = await db.from('mb_checkout_products').select('account_id')
  if (error) throw new Error('mb_checkout_products load failed')
  const accounts = [...new Set(((data ?? []) as { account_id: string }[]).map((r) => r.account_id))]
  const results: OpportunityTagResult[] = []
  for (const acc of accounts) results.push(await syncAccount(db, acc, dry))
  return { accounts: results }
}
