// ============================================================
// Cliente da API "alunos por curso" da Plataforma MB (curso.alunos.php).
// Server-to-server com a mesma chave do aluno.info.php (header X-API-KEY) e a
// mesma cota de 60 chamadas/hora por IP. A chave nunca sai do backend nem
// aparece em erro ou log.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'

const URL = 'https://app.millaborges.com/api/curso.alunos.php'
const TIMEOUT_MS = 30_000

/** Falha da API com um código curto (unauthorized, rate_limited, timeout, http_500…). */
export class MbApiError extends Error {
  constructor(readonly code: string) {
    super(`mb api error: ${code}`)
    this.name = 'MbApiError'
  }
}

/**
 * Aluno com matrícula vigente no curso. `permissao` e `mensagens_whatsapp` são
 * opcionais: a reconciliação só aplica esses filtros quando a API os envia.
 */
export interface MbCourseStudent {
  id_aluno: number
  nome: string | null
  email: string | null
  telefone: string | null
  usuario_vigente: string | null
  data_matricula?: string | null
  permissao?: number | string | null
  mensagens_whatsapp?: string | null
}

export interface MbCourseInfo {
  id_curso: number
  nome_curso: string
  vigente: string
}

export type MbCourseStudentsResult =
  | { found: false }
  | { found: true; curso: MbCourseInfo; ativos: MbCourseStudent[] }

/** Turma de um curso. `found: false` = id_curso inexistente na plataforma. */
export async function fetchCourseStudents(apiKey: string, idCurso: number): Promise<MbCourseStudentsResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
      body: JSON.stringify({ id_curso: idCurso }),
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (err) {
    throw new MbApiError((err as Error).name === 'AbortError' ? 'timeout' : 'network')
  } finally {
    clearTimeout(timeout)
  }

  if (res.status === 401) throw new MbApiError('unauthorized')
  if (res.status === 429) throw new MbApiError('rate_limited')
  if (!res.ok) throw new MbApiError(`http_${res.status}`)

  const body = (await res.json().catch(() => null)) as {
    status?: string
    curso?: MbCourseInfo
    ativos?: unknown
    truncado?: boolean
  } | null
  if (body?.status === 'curso_nao_encontrado') return { found: false }
  if (body?.status !== 'success' || !body.curso || !Array.isArray(body.ativos)) {
    throw new MbApiError('invalid_response')
  }
  // Turma cortada pelo teto da API: aplicar removeria quem ficou de fora.
  if (body.truncado === true) throw new MbApiError('truncated')
  return { found: true, curso: body.curso, ativos: body.ativos as MbCourseStudent[] }
}

/**
 * Chave da API da conta: a salva em Configurações → Integrações (criptografada) e,
 * na falta dela, a env API_ALUNO_KEY — mesma precedência do sales-cron.
 */
export async function resolveMbApiKey(db: SupabaseClient, accountId: string): Promise<string | null> {
  const { data } = await db
    .from('integrations_config')
    .select('millaborges_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  const enc = (data as { millaborges_api_key: string | null } | null)?.millaborges_api_key
  let key: string | null = null
  if (enc) {
    try {
      key = decrypt(enc)
    } catch {
      key = null
    }
  }
  return key || process.env.API_ALUNO_KEY || null
}
