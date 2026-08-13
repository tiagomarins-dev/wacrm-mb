import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getClientIp,
  requirePlaygroundAuth,
  resolvePlaygroundAccountId,
} from '@/lib/playground-ruth/auth'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { runAgentLoop } from '@/lib/ai-agent/llm'
import { buildSystemPrompt, coalesceHistory, type ChatMsg } from '@/lib/ai-agent/prompt'
import { listCursos, listSupportCategories } from '@/lib/ai-agent/knowledge'
import { extractStudentCourses, splitIntoMessages } from '@/lib/ai-agent/engine'
import { applyGuardrail, hasForbidden } from '@/lib/ai-agent/guardrail'
import type { AiProfile } from '@/types'

export const runtime = 'nodejs'

// Caps de entrada: limitam custo/abuso sem atrapalhar teste real.
// O cap de prompt precisa comportar a persona de produção da Ruth
// (~20.300 chars) com folga pra edição de versões maiores.
const MAX_MSGS = 40
const MAX_MSG_CHARS = 4000
const MAX_PROMPT_CHARS = 30000
// Contexto da campanha (081): mesmo teto do servidor de produção (prompt.ts).
const MAX_CAMPAIGN_CHARS = 2000

// Rascunho de ficha de curso (por slug): vale só pra conversa de teste.
type CourseOverride = { posicionamento?: string | null; condicao_vigente?: string | null }

interface ChatBody {
  profileId?: unknown
  personaPrompt?: unknown
  openingPrompt?: unknown
  opening?: unknown
  contactId?: unknown
  messages?: { role?: unknown; content?: unknown }[]
  courseOverrides?: unknown
  // Override de modelo (id OpenRouter, ex. anthropic/claude-sonnet-4.6).
  // Ausente = modelo do perfil. Id inválido falha no OpenRouter (telemetry.error).
  model?: unknown
  // Contexto da campanha (081) — mesmo arg que a produção passa ao buildSystemPrompt.
  campaignContext?: unknown
}

// Id de modelo OpenRouter: vendor/nome[:variante] — só caracteres seguros.
const MODEL_RE = /^[\w.\-]+\/[\w.\-]+(:[\w.\-]+)?$/

const MAX_OVERRIDE_SLUGS = 20
const MAX_OVERRIDE_CHARS = 4000

// Valida e normaliza os overrides de curso. Retorna o mapa limpo ou uma
// string de erro (vira 422 no caller).
function parseCourseOverrides(raw: unknown): Record<string, CourseOverride> | string {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return 'courseOverrides deve ser um objeto'
  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_OVERRIDE_SLUGS) return `máximo de ${MAX_OVERRIDE_SLUGS} cursos em courseOverrides`
  const out: Record<string, CourseOverride> = {}
  for (const [slug, value] of entries) {
    if (typeof value !== 'object' || value === null) return `override de ${slug} deve ser um objeto`
    const ov = value as Record<string, unknown>
    const clean: CourseOverride = {}
    for (const campo of ['posicionamento', 'condicao_vigente'] as const) {
      const v = ov[campo]
      if (v === undefined) continue
      if (v !== null && typeof v !== 'string') return `${campo} de ${slug} deve ser texto ou null`
      if (typeof v === 'string' && v.length > MAX_OVERRIDE_CHARS) {
        return `${campo} de ${slug} excede ${MAX_OVERRIDE_CHARS} caracteres`
      }
      clean[campo] = v as string | null
    }
    if (Object.keys(clean).length > 0) out[slug] = clean
  }
  return out
}

// Valida o body do turno. null = ok; NextResponse = 422 nomeando o campo.
function validateBody(body: ChatBody): NextResponse | null {
  const fail = (msg: string) => NextResponse.json({ error: msg }, { status: 422 })
  if (typeof body.profileId !== 'string' || !body.profileId) return fail('profileId obrigatório')
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return fail('messages precisa ser uma lista com pelo menos a mensagem do cliente')
  }
  if (body.messages.length > MAX_MSGS) return fail(`máximo de ${MAX_MSGS} mensagens por conversa`)
  for (const m of body.messages) {
    if (m.role !== 'user' && m.role !== 'assistant') return fail('role inválido em messages')
    if (typeof m.content !== 'string' || m.content.length > MAX_MSG_CHARS) {
      return fail(`cada mensagem deve ser texto de até ${MAX_MSG_CHARS} caracteres`)
    }
  }
  // A IA responde ao cliente: o histórico precisa terminar num turno do cliente.
  if (body.messages[body.messages.length - 1].role !== 'user') {
    return fail('a última mensagem precisa ser do cliente')
  }
  for (const [campo, valor] of [
    ['personaPrompt', body.personaPrompt],
    ['openingPrompt', body.openingPrompt],
  ] as const) {
    if (valor !== undefined && valor !== null) {
      if (typeof valor !== 'string') return fail(`${campo} deve ser texto ou null`)
      if (valor.length > MAX_PROMPT_CHARS) {
        return fail(`${campo} excede o limite de ${MAX_PROMPT_CHARS} caracteres`)
      }
    }
  }
  if (body.contactId !== undefined && body.contactId !== null && typeof body.contactId !== 'string') {
    return fail('contactId deve ser texto ou null')
  }
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string' || body.model.length > 100 || !MODEL_RE.test(body.model)) {
      return fail('model deve ser um id OpenRouter válido (ex.: anthropic/claude-sonnet-4.6)')
    }
  }
  if (body.campaignContext !== undefined && body.campaignContext !== null) {
    if (typeof body.campaignContext !== 'string') return fail('campaignContext deve ser texto ou null')
    if (body.campaignContext.length > MAX_CAMPAIGN_CHARS) {
      return fail(`campaignContext excede o limite de ${MAX_CAMPAIGN_CHARS} caracteres`)
    }
  }
  return null
}

// Roda UM turno da Ruth com o motor de produção, sem NENHUMA escrita: espelha a
// montagem de contexto do engine (contato/aluno/lead_context/catálogo) e o
// pós-processamento (supressão de handoff na abertura + guardrail + bolhas),
// pulando telemetria persistida, ai_topic, reatribuição e envio ao WhatsApp.
export async function POST(request: Request) {
  const denied = requirePlaygroundAuth(request)
  if (denied) return denied
  const limit = checkRateLimit(`pg-chat:${getClientIp(request)}`, RATE_LIMITS.playgroundChat)
  if (!limit.success) return rateLimitResponse(limit)

  const body = (await request.json().catch(() => ({}))) as ChatBody
  const invalid = validateBody(body)
  if (invalid) return invalid

  const db = supabaseAdmin()
  const anchor = await resolvePlaygroundAccountId(db)
  if ('response' in anchor) return anchor.response
  const accountId = anchor.accountId

  // Perfil da conta-âncora (cross-check de conta = defesa em profundidade).
  const { data: profileRow } = await db
    .from('ai_profiles')
    .select('*')
    .eq('id', body.profileId)
    .eq('account_id', accountId)
    .maybeSingle()
  const profile = profileRow as AiProfile | null
  if (!profile) return NextResponse.json({ error: 'perfil não encontrado' }, { status: 404 })

  // Contexto do contato (só no modo "Simular ativo") — espelho do engine.
  const contactId = (body.contactId as string | null | undefined) ?? null
  let contactName: string | null = null
  let contactEmail: string | null = null
  let student: { status: string | null; payload: unknown } | null = null
  let studentCourses: string[] = []
  let leadContext: Record<string, string> | null = null
  if (contactId) {
    const { data: contactRow } = await db
      .from('contacts')
      .select('name, email')
      .eq('id', contactId)
      .eq('account_id', accountId)
      .maybeSingle()
    contactName = (contactRow as { name: string | null } | null)?.name ?? null
    contactEmail = (contactRow as { email: string | null } | null)?.email ?? null
    const { data: studentRow } = await db
      .from('student_info')
      .select('status, payload')
      .eq('account_id', accountId)
      .eq('contact_id', contactId)
      .maybeSingle()
    student = (studentRow as { status: string | null; payload: unknown } | null) ?? null
    studentCourses = extractStudentCourses(student)
    const { data: leadRecs } = await db
      .from('broadcast_recipients')
      .select('lead_context, broadcasts!inner(account_id)')
      .eq('contact_id', contactId)
      .eq('broadcasts.account_id', accountId)
      .not('lead_context', 'is', null)
      .order('sent_at', { ascending: false })
      .limit(1)
    leadContext =
      (leadRecs?.[0] as { lead_context: Record<string, string> | null } | undefined)
        ?.lead_context ?? null
  }

  const overrides = parseCourseOverrides(body.courseOverrides)
  if (typeof overrides === 'string') {
    return NextResponse.json({ error: overrides }, { status: 422 })
  }

  // Catálogo com os rascunhos aplicados: o posicionamento é o que entra no
  // system prompt; a condição chega ao modelo via get_curso (override no ctx).
  const coursesRaw = await listCursos(db, accountId)
  const courses = coursesRaw.map((c) =>
    overrides[c.slug]?.posicionamento !== undefined
      ? { ...c, posicionamento: overrides[c.slug].posicionamento ?? null }
      : c,
  )
  const supportCategories = await listSupportCategories(db, accountId)
  const opening = body.opening === true

  // Prompts DO REQUEST (rascunho v2 da página); fallback pro perfil se undefined.
  const system = buildSystemPrompt({
    persona: body.personaPrompt !== undefined ? (body.personaPrompt as string | null) : profile.persona_prompt,
    courses,
    supportCategories,
    student,
    contactName,
    contactEmail,
    studentCourses,
    leadContext,
    opening,
    openingPrompt:
      body.openingPrompt !== undefined ? (body.openingPrompt as string | null) : profile.opening_prompt,
    // Contexto da campanha como arg dedicado (081) — em produção vem da conversa;
    // aqui vem do painel, mas atravessa o MESMO caminho no prompt.
    campaignContext: (body.campaignContext as string | null | undefined) ?? null,
  })

  const messages = coalesceHistory(body.messages as ChatMsg[])
  if (messages.length === 0) {
    return NextResponse.json(
      { error: 'histórico vazio: a primeira mensagem precisa ser do cliente' },
      { status: 422 },
    )
  }

  try {
    const result = await runAgentLoop({
      db,
      accountId,
      connectionId: '', // sintéticos: nenhuma tool lê esses ids (precedente das
      conversationId: '', // chamadas inline do engine de automações)
      contactId: contactId ?? '',
      model: (body.model as string | undefined) ?? profile.model,
      classifierModel: profile.classifier_model,
      maxTurns: profile.max_bot_turns,
      system,
      messages,
      handoffRouting: profile.handoff_routing,
      allowedTools: profile.allowed_tools,
      opening,
      linkDryRun: true, // playground nunca cria link_tokens
      courseOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
    })

    // Abertura suprime o handoff (mesma regra do engine), mas aqui REPORTAMOS
    // a supressão pra página mostrar o que teria acontecido.
    const handoffSuppressed = opening && !!result.handoff
    const handoff = handoffSuppressed ? null : result.handoff

    const guardrailHits = result.reply ? (hasForbidden(result.reply) ? 1 : 0) : 0
    const safe = result.reply?.trim() ? applyGuardrail(result.reply) : null
    const bubbles = safe ? splitIntoMessages(safe) : []

    return NextResponse.json({
      bubbles,
      reply: safe,
      topic: result.topic,
      events: {
        handoff,
        handoffSuppressed,
        encerrar: result.telemetry.toolsUsed.includes('encerrar') && !safe,
        linkDryRun: result.telemetry.toolsUsed.includes('enviar_link_venda'),
      },
      guardrailHits,
      telemetry: result.telemetry, // erro do loop chega aqui (200 + telemetry.error)
    })
  } catch (err) {
    // Falha pré-loop (ex.: chave OpenRouter não configurada) — mensagem curta,
    // nunca o body cru (pode ecoar dado de contato).
    return NextResponse.json(
      { error: err instanceof Error ? err.message.slice(0, 200) : 'falha ao rodar o agente' },
      { status: 502 },
    )
  }
}
