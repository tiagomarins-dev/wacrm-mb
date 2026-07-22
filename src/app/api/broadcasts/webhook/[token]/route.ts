// ============================================================
// POST /api/broadcasts/webhook/[token]
//
// Público — dispara UM broadcast a partir do blueprint (status='webhook')
// identificado pelo token bh_ da URL (mig 075). Blueprint+clone:
// audiência resolvida NA HORA (lista nunca congela) e variáveis
// {type:'payload'} materializadas em 'static' no clone — o cron/engine
// de envio seguem intocados.
// Segurança/consistência:
//   - rate limit por IP antes de qualquer I/O (anti-enumeração)
//   - X-Idempotency-Key OBRIGATÓRIA (replay = turma inteira de novo);
//     consumida DEPOIS das validações (400 não queima a key) e
//     LIBERADA em falha pós-consumo (retry legítimo precisa passar)
//   - clone nasce 'draft' e só vira 'sending' com recipients completos
//     (o cron a ~1min marcaria 'failed' um sending com 0 pending)
//   - ?dry=1: resolve audiência e retorna a contagem sem criar nada
//     nem consumir a key
// ============================================================
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/broadcast/admin-client'
import {
  collectPayloadKeys,
  materializePayloadVariables,
  type VariableMapping,
} from '@/lib/broadcast/variables'
import {
  resolveBlueprintAudience,
  type BlueprintAudienceFilter,
} from '@/lib/broadcast/audience'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

const MAX_BODY_BYTES = 32 * 1024
const MAX_VALUE_LEN = 500
const INSERT_BATCH_SIZE = 200

// IP best-effort (espelha automations/webhook/[token]/route.ts)
function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

// Valor aceito nas variáveis do payload: primitivo e curto
function isValidValue(v: unknown): boolean {
  if (typeof v === 'string') return v.length <= MAX_VALUE_LEN
  return typeof v === 'number' || typeof v === 'boolean'
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  // 1. Rate limit por IP antes de qualquer I/O de banco
  const ip = getClientIp(request)
  const limit = checkRateLimit(`bcwh:${ip}`, RATE_LIMITS.broadcastWebhook)
  if (!limit.success) return rateLimitResponse(limit)

  // 2. Idempotency key OBRIGATÓRIA (replay dispara a turma inteira)
  const idemKey = request.headers.get('x-idempotency-key')
  if (!idemKey) {
    return NextResponse.json(
      {
        error:
          'Header X-Idempotency-Key é obrigatório (ex: aula-2026-07-23-1830). Requests com a mesma chave em 24h não disparam de novo.',
      },
      { status: 400 },
    )
  }
  if (idemKey.length > 200) {
    return NextResponse.json(
      { error: 'X-Idempotency-Key deve ter no máximo 200 caracteres.' },
      { status: 400 },
    )
  }

  // 3. Cap de tamanho + parse (body vazio = payload {})
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload excede 32KB.' }, { status: 413 })
  }
  let payload: Record<string, unknown>
  try {
    payload = raw.trim() === '' ? {} : JSON.parse(raw)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('not an object')
    }
  } catch {
    return NextResponse.json(
      { error: 'Corpo da requisição não é um objeto JSON válido.' },
      { status: 400 },
    )
  }

  const db = supabaseAdmin()
  const { token } = await params
  let blueprintId: string | null = null
  let cloneId: string | null = null
  let idemConsumed = false

  try {
    // 4. Resolve o blueprint pelo token — 404 genérico em qualquer falha
    const { data: blueprint } = await db
      .from('broadcasts')
      .select(
        'id, user_id, account_id, connection_id, name, template_name, template_language, template_variables, audience_filter',
      )
      .eq('webhook_token', token)
      .eq('status', 'webhook')
      .maybeSingle()
    if (!blueprint || !blueprint.connection_id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    blueprintId = blueprint.id as string
    const variables = (blueprint.template_variables ?? {}) as Record<
      string,
      VariableMapping
    >

    // 5. Chaves do payload mapeadas nas variáveis têm que vir no body
    const requiredKeys = collectPayloadKeys(variables)
    const missing = requiredKeys.filter((k) => payload[k] === undefined)
    if (missing.length > 0) {
      return NextResponse.json(
        { error: 'Chaves obrigatórias ausentes no payload.', missing_keys: missing },
        { status: 400 },
      )
    }
    const badValue = requiredKeys.filter((k) => !isValidValue(payload[k]))
    if (badValue.length > 0) {
      return NextResponse.json(
        {
          error: 'Valores devem ser texto (até 500 caracteres), número ou booleano.',
          invalid_keys: badValue,
        },
        { status: 400 },
      )
    }

    // 6/7. Audiência resolvida NA HORA (lista nunca congela)
    const filter = (blueprint.audience_filter ?? {
      type: 'all',
    }) as BlueprintAudienceFilter
    let contacts: { id: string }[]
    try {
      contacts = await resolveBlueprintAudience(
        db,
        blueprint.account_id as string,
        blueprint.connection_id as string,
        filter,
      )
    } catch {
      return NextResponse.json(
        { error: 'Audiência do blueprint não suportada pelo webhook (use Todos ou Tags).' },
        { status: 400 },
      )
    }

    // 6. Dry-run: só a contagem — nada criado, key não consumida
    const dry = new URL(request.url).searchParams.get('dry')
    if (dry === '1' || dry === 'true') {
      return NextResponse.json({ ok: true, dry: true, count: contacts.length })
    }

    // 7b. Audiência vazia: nada a fazer (broadcast vazio nunca finalizaria)
    if (contacts.length === 0) {
      return NextResponse.json({ ok: true, recipients: 0 })
    }

    // 8. Idempotência insert-first — DEPOIS das validações (400 não queima
    //    a key), ANTES do clone. Corrida resolve no UNIQUE (23505).
    const { error: idemErr } = await db
      .from('broadcast_webhook_events')
      .insert({ broadcast_id: blueprintId, idempotency_key: idemKey })
    if (idemErr) {
      if (idemErr.code === '23505') {
        return NextResponse.json({ ok: true, duplicate: true })
      }
      throw idemErr
    }
    idemConsumed = true

    // 9. Clone nasce DRAFT — o cron ignora draft; um 'sending' com 0
    //    pending seria finalizado como 'failed' pelo drainBroadcast.
    const now = new Date()
    const { data: clone, error: cloneErr } = await db
      .from('broadcasts')
      .insert({
        user_id: blueprint.user_id,
        account_id: blueprint.account_id,
        connection_id: blueprint.connection_id,
        source_blueprint_id: blueprintId,
        name: `${blueprint.name} — ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
        template_name: blueprint.template_name,
        template_language: blueprint.template_language,
        template_variables: materializePayloadVariables(variables, payload),
        audience_filter: blueprint.audience_filter,
        status: 'draft',
        scheduled_at: null,
        total_recipients: contacts.length,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
      })
      .select('id')
      .single()
    if (cloneErr || !clone) throw cloneErr ?? new Error('clone insert failed')
    cloneId = clone.id as string

    // 10. Recipients em lotes de 200 (espelha use-broadcast-sending.ts)
    const rows = contacts.map((c) => ({
      broadcast_id: cloneId,
      contact_id: c.id,
      status: 'pending' as const,
    }))
    for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
      const { error: recErr } = await db
        .from('broadcast_recipients')
        .insert(rows.slice(i, i + INSERT_BATCH_SIZE))
      if (recErr) throw recErr
    }

    // 11. Só agora o clone entra na fila do cron
    const { error: flipErr } = await db
      .from('broadcasts')
      .update({ status: 'sending' })
      .eq('id', cloneId)
    if (flipErr) throw flipErr

    // 12. Aceito — o cron drena no próximo tick (~1min)
    return NextResponse.json(
      { ok: true, broadcast_id: cloneId, recipients: contacts.length },
      { status: 202 },
    )
  } catch (err) {
    // Nunca logar body nem token
    console.error('[broadcast-webhook] error:', err)
    // Falha pós-consumo: libera a key (retry legítimo precisa passar) e
    // marca o clone parcial como failed — tudo best-effort.
    if (idemConsumed && blueprintId) {
      try {
        await db
          .from('broadcast_webhook_events')
          .delete()
          .eq('broadcast_id', blueprintId)
          .eq('idempotency_key', idemKey)
      } catch {
        // best-effort
      }
    }
    if (cloneId) {
      try {
        await db.from('broadcasts').update({ status: 'failed' }).eq('id', cloneId)
      } catch {
        // best-effort
      }
    }
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }
}
