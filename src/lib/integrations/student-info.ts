// ============================================================
// Millaborges "Info Aluno" — chamada server-to-server. A key NUNCA sai do
// backend (vai no header X-API-KEY). Body manda email+telefone; a API
// resolve por email primeiro (precedência email → cpf → telefone).
// ============================================================

const URL = 'https://app.millaborges.com/api/aluno.info.php'
const TIMEOUT_MS = 15_000

export interface AlunoCadastro {
  id: number
  nome: string
  email: string
  telefone: string
  cpf: string
  data_nascimento: string
  permissao: number
  vigente: string // "S" | "N"
}
export interface CursoMatriculado {
  id_curso: number
  nome_curso: string
  tag: string
  data_matricula: string
}
export interface Redacoes {
  total: number
  por_ano_banca: { ano: number; id_banca: number; nome_banca: string; total: number }[]
}
export interface ProgressoAulas {
  percentual_geral: number
  por_curso: {
    id_curso: number
    nome_curso: string
    total_aulas: number
    aulas_concluidas: number
    percentual_concluidas: number
    media_video_assistido: number
  }[]
}
export interface CandidatoAluno {
  id: number
  nome: string
  email: string
  telefone: string
}

export interface StudentInfoResponse {
  status: 'success' | 'nao_encontrado' | 'multiplos' | string
  matched_by?: 'email' | 'cpf' | 'telefone' | null
  aluno?: AlunoCadastro
  cursos_matriculados?: CursoMatriculado[]
  redacoes?: Redacoes
  progresso_aulas?: ProgressoAulas
  candidatos?: CandidatoAluno[]
}

/**
 * Consulta o panorama do aluno por email/telefone. Lança em falha de
 * rede/timeout/HTTP (o caller decide o fallback). Nunca inclui a key na
 * mensagem de erro. HTTP 200 cobre success/nao_encontrado/multiplos.
 */
export async function fetchStudentInfo(args: {
  apiKey: string
  email?: string | null
  phone?: string | null
}): Promise<StudentInfoResponse> {
  const body: Record<string, string> = {}
  if (args.email?.trim()) body.email = args.email.trim()
  if (args.phone?.trim()) body.telefone = args.phone.trim()

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': args.apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('Millaborges timed out')
    throw new Error('Millaborges request failed')
  } finally {
    clearTimeout(timeout)
  }
  // 401/403/405/429/500 → erro (sem vazar a key).
  if (!res.ok) throw new Error(`Millaborges error ${res.status}`)
  return (await res.json()) as StudentInfoResponse
}
