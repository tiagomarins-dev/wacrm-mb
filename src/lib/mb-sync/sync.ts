// ============================================================
// sync.ts — cron horário das turmas MB. Para cada tag mapeada em mb_class_sync,
// deixa contact_tags exatamente com os contatos (conexão de Suporte) dos alunos
// elegíveis da união dos cursos ligados a ela. A tag pertence ao sync: vínculo
// manual, de qualquer conexão, sai. Regra pura em ./reconcile.ts.
// Alunos vêm da API curso.alunos.php (uma chamada por curso por conta; a cota é
// de 60/hora por IP, compartilhada com o aluno.info.php).
// Service-role (sem RLS): o isolamento é o account_id do par + checagem da tag.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import {
  resolveSupportConfig,
  SupportConnectionError,
  type SupportConfig,
} from '@/lib/connections/support'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { fetchCourseStudents, MbApiError, resolveMbApiKey } from './platform-api'
import { phoneKeys, toCanonicalBr } from './phone'
import {
  diffTag,
  filterEligible,
  matchStudents,
  parseIdList,
  removalGuard,
  type ContactLite,
  type MbStudentRow,
} from './reconcile'

const PAGE = 1000 // teto de linhas por resposta do PostgREST
const KEY_CHUNK = 200 // chaves por IN (limite de URL)
const INSERT_CHUNK = 200
const TAG_CHUNK = 100 // mesmo lote de resolve-import-tags.ts
const DELETE_CHUNK = 200

export interface TagSyncResult {
  tag_id: string
  students: number
  added: number
  removed: number
  created: number
  skipped: number
  aborted: string | null
}

interface TagGroup {
  accountId: string
  tagId: string
  courseIds: number[] // ordenado — compõe a base da guarda
}

type PairRow = { account_id: string; mb_course_id: number; tag_id: string }
type MemberRow = { id: string; contact_id: string }

// Pares → um grupo por (conta, tag), com os cursos em ordem crescente.
function groupByTag(pairs: PairRow[]): TagGroup[] {
  const map = new Map<string, TagGroup>()
  for (const p of pairs) {
    const key = `${p.account_id}:${p.tag_id}`
    const g = map.get(key) ?? { accountId: p.account_id, tagId: p.tag_id, courseIds: [] }
    if (!g.courseIds.includes(p.mb_course_id)) g.courseIds.push(p.mb_course_id)
    map.set(key, g)
  }
  for (const g of map.values()) g.courseIds.sort((a, b) => a - b)
  return [...map.values()]
}

function emptyResult(tagId: string): TagSyncResult {
  return { tag_id: tagId, students: 0, added: 0, removed: 0, created: 0, skipped: 0, aborted: null }
}

// Log do run; falha no log não derruba a sincronização (só o código vai pro console).
async function insertRun(db: SupabaseClient, g: TagGroup, r: TagSyncResult): Promise<void> {
  const { error } = await db.from('mb_class_sync_runs').insert({
    account_id: g.accountId,
    tag_id: g.tagId,
    course_ids: g.courseIds,
    students: r.students,
    added: r.added,
    removed: r.removed,
    created: r.created,
    skipped: r.skipped,
    aborted_reason: r.aborted,
  })
  if (error) console.error('[mb-sync] run log failed:', (error as { code?: string }).code)
}

// Total do último run aplicado com o MESMO conjunto de cursos (base da guarda).
async function loadLastOkStudents(db: SupabaseClient, g: TagGroup): Promise<number | null> {
  const { data, error } = await db
    .from('mb_class_sync_runs')
    .select('students, course_ids')
    .eq('tag_id', g.tagId)
    .is('aborted_reason', null)
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error('mb_class_sync_runs load failed')
  const row = data as { students: number; course_ids: number[] | null } | null
  if (!row) return null
  const previous = [...(row.course_ids ?? [])].sort((a, b) => a - b)
  const same =
    previous.length === g.courseIds.length && previous.every((id, i) => id === g.courseIds[i])
  return same ? row.students : null
}

// Contatos da conexão cujo phone_normalized bate com alguma chave dos alunos.
async function loadContacts(
  db: SupabaseClient,
  accountId: string,
  connectionId: string,
  students: MbStudentRow[],
): Promise<ContactLite[]> {
  const keys = new Set<string>()
  for (const s of students) {
    const canonical = toCanonicalBr(s.telefone)
    if (canonical) for (const k of phoneKeys(canonical)) keys.add(k)
  }
  const all = [...keys]
  const out: ContactLite[] = []
  for (let i = 0; i < all.length; i += KEY_CHUNK) {
    const { data, error } = await db
      .from('contacts')
      .select('id, phone_normalized')
      .eq('account_id', accountId)
      .eq('connection_id', connectionId)
      .in('phone_normalized', all.slice(i, i + KEY_CHUNK))
    if (error) throw new Error('contacts load failed')
    out.push(...((data ?? []) as ContactLite[]))
  }
  return out
}

// Vínculos atuais da tag, paginados (turmas passam de 1000).
async function loadTagMembers(db: SupabaseClient, tagId: string): Promise<MemberRow[]> {
  const out: MemberRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('contact_tags')
      .select('id, contact_id')
      .eq('tag_id', tagId)
      .order('id')
      .range(from, from + PAGE - 1)
    if (error) throw new Error('contact_tags load failed')
    const page = (data ?? []) as MemberRow[]
    out.push(...page)
    if (page.length < PAGE) break
  }
  return out
}

/**
 * Cria os contatos faltantes. O unique de contacts é índice parcial (mig 033),
 * então não há upsert: insere em bloco e, se outro caminho criou um deles no meio
 * (23505), refaz linha a linha e reaproveita o existente — mesmo fallback do inbound.
 * Retorna os ids de todos (novos + reaproveitados) e quantos foram criados.
 */
async function createContacts(
  db: SupabaseClient,
  support: SupportConfig,
  toCreate: { phone: string; name: string }[],
): Promise<{ ids: string[]; created: number }> {
  const ids: string[] = []
  let created = 0
  for (let i = 0; i < toCreate.length; i += INSERT_CHUNK) {
    const rows = toCreate.slice(i, i + INSERT_CHUNK).map((c) => ({
      account_id: support.account_id,
      user_id: support.user_id, // coluna de auditoria NOT NULL: dono da conexão, como no inbound
      connection_id: support.id,
      phone: c.phone,
      name: c.name,
    }))
    const bulk = await db.from('contacts').insert(rows).select('id')
    if (!bulk.error) {
      for (const r of (bulk.data ?? []) as { id: string }[]) ids.push(r.id)
      created += rows.length
      continue
    }
    if (!isUniqueViolation(bulk.error)) throw new Error('contacts insert failed')

    // Bloco rejeitado inteiro por uma colisão: resolve linha a linha.
    for (const row of rows) {
      const one = await db.from('contacts').insert(row).select('id').single()
      if (!one.error) {
        ids.push((one.data as { id: string }).id)
        created++
        continue
      }
      if (!isUniqueViolation(one.error)) throw new Error('contacts insert failed')
      const existing = await db
        .from('contacts')
        .select('id')
        .eq('account_id', row.account_id)
        .eq('connection_id', row.connection_id)
        .eq('phone_normalized', row.phone)
        .maybeSingle()
      if (existing.data) ids.push((existing.data as { id: string }).id)
    }
  }
  return { ids, created }
}

// Aplica (ou simula) a sincronização de uma tag.
async function syncTag(
  db: SupabaseClient,
  g: TagGroup,
  tagAccountId: string | undefined,
  rows: MbStudentRow[],
  teamIds: Set<number>,
  dry: boolean,
): Promise<TagSyncResult> {
  const result = emptyResult(g.tagId)
  const abort = async (reason: string): Promise<TagSyncResult> => {
    result.aborted = reason
    if (!dry) await insertRun(db, g, result)
    return result
  }

  // Par apontando para tag de outra conta nunca toca vínculos (service-role ignora RLS).
  if (tagAccountId !== g.accountId) return abort('tag_account_mismatch')

  let support: SupportConfig
  try {
    support = await resolveSupportConfig(db, g.accountId)
  } catch (err) {
    if (err instanceof SupportConnectionError) return abort(`support_${err.reason}`)
    throw err
  }

  const students = filterEligible(rows, g.courseIds, teamIds)
  result.students = students.length
  const guard = removalGuard(students.length, await loadLastOkStudents(db, g))
  if (guard) return abort(guard)

  const contacts = await loadContacts(db, g.accountId, support.id, students)
  const match = matchStudents(students, contacts)
  const current = await loadTagMembers(db, g.tagId)
  result.skipped = match.skipped

  if (dry) {
    const diff = diffTag(match.matchedContactIds, current)
    result.created = match.toCreate.length
    result.added = diff.add.length + match.toCreate.length
    result.removed = diff.remove.length
    return result
  }

  // Contatos novos entram no conjunto desejado antes do diff.
  const createdContacts = await createContacts(db, support, match.toCreate)
  result.created = createdContacts.created
  const diff = diffTag([...match.matchedContactIds, ...createdContacts.ids], current)

  for (let i = 0; i < diff.add.length; i += TAG_CHUNK) {
    const chunk = diff.add
      .slice(i, i + TAG_CHUNK)
      .map((contact_id) => ({ contact_id, tag_id: g.tagId }))
    const { error } = await db
      .from('contact_tags')
      .upsert(chunk, { onConflict: 'contact_id,tag_id', ignoreDuplicates: true })
    if (error) throw new Error('contact_tags upsert failed')
  }
  for (let i = 0; i < diff.remove.length; i += DELETE_CHUNK) {
    const { error } = await db
      .from('contact_tags')
      .delete()
      .eq('tag_id', g.tagId)
      .in('id', diff.remove.slice(i, i + DELETE_CHUNK))
    if (error) throw new Error('contact_tags delete failed')
  }
  result.added = diff.add.length
  result.removed = diff.remove.length
  await insertRun(db, g, result)
  return result
}

/**
 * Entrada do cron. `dry` calcula tudo e não grava nada (nem o run) — usado para
 * validar em produção antes de aplicar. Retorna só contagens (sem PII).
 */
export async function runMbClassSync({ dry }: { dry: boolean }): Promise<{ tags: TagSyncResult[] }> {
  const db = supabaseAdmin()

  const { data: pairs, error: pairsErr } = await db
    .from('mb_class_sync')
    .select('account_id, mb_course_id, tag_id')
  if (pairsErr) throw new Error('mb_class_sync load failed')
  const groups = groupByTag((pairs ?? []) as PairRow[])
  if (groups.length === 0) return { tags: [] }

  const { data: tagRows, error: tagErr } = await db
    .from('tags')
    .select('id, account_id')
    .in('id', groups.map((g) => g.tagId))
  if (tagErr) throw new Error('tags load failed')
  const tagAccount = new Map(
    ((tagRows ?? []) as { id: string; account_id: string }[]).map((t) => [t.id, t.account_id]),
  )

  const teamIds = parseIdList(process.env.MB_TEAM_USER_IDS)
  const results: TagSyncResult[] = []

  // Uma conta por vez: chave própria e uma chamada à API por curso distinto.
  const accounts = [...new Set(groups.map((g) => g.accountId))]
  for (const accountId of accounts) {
    const accountGroups = groups.filter((g) => g.accountId === accountId)
    // Par com tag de outra conta nem consome cota da API.
    const valid = accountGroups.filter((g) => tagAccount.get(g.tagId) === accountId)
    for (const g of accountGroups.filter((x) => !valid.includes(x))) {
      results.push(await recordAbort(db, g, 'tag_account_mismatch', dry))
    }
    if (valid.length === 0) continue

    const apiKey = await resolveMbApiKey(db, accountId)
    if (!apiKey) {
      for (const g of valid) results.push(await recordAbort(db, g, 'api_unconfigured', dry))
      continue
    }

    const { rowsByCourse, failures } = await loadCourses(apiKey, valid)
    for (const g of valid) {
      // Sem a turma completa de todos os cursos da tag, aplicar removeria alunos.
      const failure = g.courseIds.map((id) => failures.get(id)).find((f): f is string => !!f)
      if (failure) {
        results.push(await recordAbort(db, g, failure, dry))
        continue
      }
      const rows = g.courseIds.flatMap((id) => rowsByCourse.get(id) ?? [])
      results.push(await syncTag(db, g, tagAccount.get(g.tagId), rows, teamIds, dry))
    }
  }
  return { tags: results }
}

// Registra um run abortado sem ter tocado contatos nem vínculos.
async function recordAbort(
  db: SupabaseClient,
  g: TagGroup,
  reason: string,
  dry: boolean,
): Promise<TagSyncResult> {
  const result = { ...emptyResult(g.tagId), aborted: reason }
  if (!dry) await insertRun(db, g, result)
  return result
}

/**
 * Busca a turma de cada curso distinto das tags da conta, em sequência (cota da API).
 * Curso encerrado na plataforma entra sem alunos; curso inexistente e erro da API
 * viram motivo de aborto. Chave recusada (401) vale para todos os cursos seguintes.
 */
async function loadCourses(
  apiKey: string,
  groups: TagGroup[],
): Promise<{ rowsByCourse: Map<number, MbStudentRow[]>; failures: Map<number, string> }> {
  const rowsByCourse = new Map<number, MbStudentRow[]>()
  const failures = new Map<number, string>()
  const courseIds = [...new Set(groups.flatMap((g) => g.courseIds))]
  for (const id of courseIds) {
    try {
      const res = await fetchCourseStudents(apiKey, id)
      if (!res.found) failures.set(id, 'course_not_found')
      else if ((res.curso.vigente ?? '').toUpperCase() !== 'S') rowsByCourse.set(id, [])
      else rowsByCourse.set(id, res.ativos.map((a) => ({ ...a, id_curso: id })))
    } catch (err) {
      if (!(err instanceof MbApiError)) throw err
      failures.set(id, `api_${err.code}`)
      if (err.code === 'unauthorized') {
        for (const rest of courseIds) if (!rowsByCourse.has(rest)) failures.set(rest, 'api_unauthorized')
        break
      }
    }
  }
  return { rowsByCourse, failures }
}
