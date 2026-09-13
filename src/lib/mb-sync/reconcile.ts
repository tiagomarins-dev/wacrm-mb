// ============================================================
// Regra pura da sincronização de turmas: quem entra na tag, quem sai, e quando
// NÃO aplicar (guarda anti-remoção em massa). Sem I/O — testável isolado; o
// orquestrador é sync.ts.
// ============================================================
import { phoneKeys, toCanonicalBr } from './phone'
import type { MbCourseStudent } from './platform-api'

/**
 * Aluno com matrícula vigente num curso, vindo da API curso.alunos.php
 * (platform-api.ts) com o id do curso consultado.
 */
export interface MbStudentRow extends MbCourseStudent {
  id_curso: number
}

export interface ContactLite {
  id: string
  phone_normalized: string
}

export interface MatchResult {
  /** contatos existentes que devem carregar a tag */
  matchedContactIds: string[]
  /** alunos sem contato na conexão — criar com phone canônico */
  toCreate: { phone: string; name: string }[]
  /** telefone ausente/inválido na plataforma */
  skipped: number
}

// Equipe nunca entra em turma: permissões administrativas e domínio da empresa.
const TEAM_PERMISSIONS = new Set([1, 5, 50])
const TEAM_EMAIL_DOMAIN = '@profmillaborges.com'
// Abaixo disso a variação relativa é ruído (turma pequena) e a guarda não atua.
const GUARD_MIN_BASE = 20

/** "20, 31" → Set{20, 31}; ignora o que não for inteiro positivo. */
export function parseIdList(raw: string | null | undefined): Set<number> {
  const out = new Set<number>()
  for (const part of (raw ?? '').split(',')) {
    const n = Number(part.trim())
    if (part.trim() !== '' && Number.isInteger(n) && n > 0) out.add(n)
  }
  return out
}

/**
 * Alunos elegíveis da união dos cursos da tag, um por aluno. Fora: cadastro
 * desativado, e-mail do domínio da empresa e ids listados em MB_TEAM_USER_IDS.
 * Opt-out de WhatsApp e permissões de equipe só filtram quando a API envia
 * esses campos — ausentes, o aluno segue elegível.
 */
export function filterEligible(
  rows: MbStudentRow[],
  courseIds: number[],
  teamIds: Set<number>,
): MbStudentRow[] {
  const courses = new Set(courseIds)
  const byStudent = new Map<number, MbStudentRow>()
  for (const r of rows) {
    if (!courses.has(r.id_curso) || byStudent.has(r.id_aluno)) continue
    if ((r.usuario_vigente ?? '').toUpperCase() !== 'S') continue
    if ((r.mensagens_whatsapp ?? '').toUpperCase() === 'N') continue
    if (r.permissao != null && TEAM_PERMISSIONS.has(Number(r.permissao))) continue
    if ((r.email ?? '').trim().toLowerCase().endsWith(TEAM_EMAIL_DOMAIN)) continue
    if (teamIds.has(r.id_aluno)) continue
    byStudent.set(r.id_aluno, r)
  }
  return [...byStudent.values()]
}

/**
 * Casa alunos com contatos da conexão pelas chaves de phoneKeys (ordem = prioridade).
 * Telefone repetido entre usuários vira um contato só; quando a mesma pessoa existe
 * com e sem o 9, só o contato da chave de maior prioridade recebe a tag.
 */
export function matchStudents(students: MbStudentRow[], contacts: ContactLite[]): MatchResult {
  const byKey = new Map<string, string>()
  for (const c of contacts) if (!byKey.has(c.phone_normalized)) byKey.set(c.phone_normalized, c.id)

  const matched = new Set<string>()
  const toCreate: { phone: string; name: string }[] = []
  const seenPhones = new Set<string>()
  let skipped = 0

  for (const s of students) {
    const canonical = toCanonicalBr(s.telefone)
    if (!canonical) {
      skipped++
      continue
    }
    if (seenPhones.has(canonical)) continue
    seenPhones.add(canonical)
    const hit = phoneKeys(canonical)
      .map((k) => byKey.get(k))
      .find((id): id is string => !!id)
    if (hit) matched.add(hit)
    else toCreate.push({ phone: canonical, name: s.nome?.trim() || canonical })
  }
  return { matchedContactIds: [...matched], toCreate, skipped }
}

/** Vínculos a criar (contact_ids) e a apagar (ids de contact_tags). */
export function diffTag(
  desiredContactIds: Iterable<string>,
  current: { id: string; contact_id: string }[],
): { add: string[]; remove: string[] } {
  const desired = new Set(desiredContactIds)
  const currentIds = new Set(current.map((c) => c.contact_id))
  return {
    add: [...desired].filter((id) => !currentIds.has(id)),
    remove: current.filter((c) => !desired.has(c.contact_id)).map((c) => c.id),
  }
}

/**
 * Motivo para abortar sem gravar, ou null. `lastOkStudents` é o total do último run
 * aplicado com o MESMO conjunto de cursos (null quando não existe) — trocar os cursos
 * de uma tag zera a base, então uma queda legítima por reconfiguração não trava.
 */
export function removalGuard(students: number, lastOkStudents: number | null): string | null {
  if (students === 0) return 'no_eligible_students'
  if (lastOkStudents !== null && lastOkStudents >= GUARD_MIN_BASE && students < lastOkStudents * 0.5) {
    return 'drop_over_50pct'
  }
  return null
}
