// ============================================================
// POST /api/automations/webhook/[token]
//
// Público — sem sessão. Dispara UMA automação (trigger
// webhook_received) identificada pelo token da URL (mig 074).
// Modelo de segurança:
//   - token wh_+32hex em texto plano na coluna (re-exibível no builder);
//     404 genérico pra token inválido/automação inativa (não vaza existência)
//   - rate limit por IP ANTES de tocar o DB (anti-enumeração — key por
//     token criaria um bucket novo a cada tentativa e nunca estouraria)
//   - caps: body 32KB, idempotency key 200 chars, strings 500 chars
//   - todo campo extra do payload precisa existir em custom_fields (400 senão)
//   - nota: o POST /api/automations/engine (autenticado) também aceita
//     webhook_received e roda todas as automações webhook da conta —
//     mesmo tenant, sem token; intencional.
// ============================================================
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { runSingleAutomation } from '@/lib/automations/engine'
import {
  findOrCreateContact,
  findOrCreateConversation,
} from '@/lib/whatsapp/inbound'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import type { Automation } from '@/types'

const RESERVED_KEYS = ['phone', 'name', 'email'] as const
const MAX_BODY_BYTES = 32 * 1024
const MAX_VALUE_LEN = 500
const PHONE_RE = /^\d{10,15}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// IP best-effort (espelha invitations/[token]/peek/route.ts:45-51)
function getClientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for')
  if (xff) return xff.split(',')[0].trim()
  const xri = request.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

// Valor aceito no payload: primitivo e curto (evita "[object Object]" em
// custom value e inflar automation_logs/pending_executions via jsonb)
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
  const limit = checkRateLimit(`autowh:${ip}`, RATE_LIMITS.automationWebhook)
  if (!limit.success) return rateLimitResponse(limit)

  // 2. Cap de tamanho + parse
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload excede 32KB.' }, { status: 413 })
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(raw)
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('not an object')
    }
  } catch {
    return NextResponse.json(
      { error: 'Corpo da requisição não é um objeto JSON válido.' },
      { status: 400 },
    )
  }

  // 3. Telefone obrigatório, só dígitos DDI+DDD+número
  const phone = payload.phone
  if (typeof phone !== 'string' || !PHONE_RE.test(phone)) {
    return NextResponse.json(
      {
        error:
          'Campo "phone" é obrigatório e deve conter apenas dígitos no formato DDI+DDD+telefone (10 a 15 dígitos, ex: 5521999998888).',
      },
      { status: 400 },
    )
  }

  // 4. Idempotency key: opcional, cap de 200 (espelha o CHECK da mig 074)
  const idemKey = request.headers.get('x-idempotency-key')
  if (idemKey && idemKey.length > 200) {
    return NextResponse.json(
      { error: 'X-Idempotency-Key deve ter no máximo 200 caracteres.' },
      { status: 400 },
    )
  }

  // Validação de name/email
  if (payload.name !== undefined && !isValidValue(payload.name)) {
    return NextResponse.json(
      { error: 'Campo "name" deve ser texto de até 500 caracteres.' },
      { status: 400 },
    )
  }
  if (payload.email !== undefined) {
    if (typeof payload.email !== 'string' || !EMAIL_RE.test(payload.email)) {
      return NextResponse.json({ error: 'Campo "email" inválido.' }, { status: 400 })
    }
  }

  try {
    const db = supabaseAdmin()
    const { token } = await params

    // 5. Resolve a automação pelo token — 404 genérico em qualquer falha
    const { data: automation } = await db
      .from('automations')
      .select('*')
      .eq('webhook_token', token)
      .eq('trigger_type', 'webhook_received')
      .eq('is_active', true)
      .maybeSingle()
    if (!automation || !automation.connection_id) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    const auto = automation as Automation

    // 6. Campos extras têm que existir em custom_fields do account
    const extraKeys = Object.keys(payload).filter(
      (k) => !RESERVED_KEYS.includes(k as (typeof RESERVED_KEYS)[number]),
    )
    const fieldIdByName = new Map<string, string>()
    if (extraKeys.length > 0) {
      const { data: fields, error: fieldsErr } = await db
        .from('custom_fields')
        .select('id, field_name')
        .eq('account_id', auto.account_id)
      if (fieldsErr) throw fieldsErr
      for (const f of fields ?? []) {
        fieldIdByName.set(f.field_name as string, f.id as string)
      }
      const invalid = extraKeys.filter((k) => !fieldIdByName.has(k))
      if (invalid.length > 0) {
        return NextResponse.json(
          {
            error:
              'Campos não cadastrados no CRM. Crie os campos customizados antes de usá-los.',
            invalid_fields: invalid,
          },
          { status: 400 },
        )
      }
      const badValue = extraKeys.filter((k) => !isValidValue(payload[k]))
      if (badValue.length > 0) {
        return NextResponse.json(
          {
            error:
              'Valores devem ser texto (até 500 caracteres), número ou booleano.',
            invalid_fields: badValue,
          },
          { status: 400 },
        )
      }
    }

    // 7. Idempotência insert-first: corrida de dois requests com a mesma
    //    key resolve no UNIQUE (23505) — sem janela select-then-insert
    if (idemKey) {
      const { error: idemErr } = await db
        .from('automation_webhook_events')
        .insert({ automation_id: auto.id, idempotency_key: idemKey })
      if (idemErr) {
        if (idemErr.code === '23505') {
          return NextResponse.json({ ok: true, duplicate: true })
        }
        throw idemErr
      }
    }

    // 8. Contato (find-or-create; helper já deduplica e recupera race)
    const name = typeof payload.name === 'string' ? payload.name : ''
    const outcome = await findOrCreateContact(
      db,
      auto.account_id,
      auto.user_id,
      auto.connection_id!,
      phone,
      name,
    )
    if (!outcome) throw new Error('contact resolution failed')
    const contact = outcome.contact

    // name/email sobrescrevem sempre (decisão: payload é fonte da verdade)
    const contactUpdate: Record<string, unknown> = {}
    if (name) contactUpdate.name = name
    if (typeof payload.email === 'string') contactUpdate.email = payload.email
    if (Object.keys(contactUpdate).length > 0) {
      contactUpdate.updated_at = new Date().toISOString()
      await db.from('contacts').update(contactUpdate).eq('id', contact.id)
    }

    // 9. Custom values (espelha o upsert do engine.ts, step update_contact_field)
    for (const k of extraKeys) {
      const { error: upErr } = await db.from('contact_custom_values').upsert(
        {
          contact_id: contact.id,
          custom_field_id: fieldIdByName.get(k)!,
          value: String(payload[k]),
        },
        { onConflict: 'contact_id,custom_field_id' },
      )
      if (upErr) throw upErr
    }

    // 10. Conversa (find-or-create escopado à conexão da automação)
    const conversation = await findOrCreateConversation(
      db,
      auto.account_id,
      auto.user_id,
      auto.connection_id!,
      contact.id,
    )
    if (!conversation) throw new Error('conversation resolution failed')

    // 11. Dispatch fire-and-forget — payload inteiro vira {{vars.*}}
    void runSingleAutomation(auto, {
      accountId: auto.account_id,
      connectionId: auto.connection_id,
      triggerType: 'webhook_received',
      contactId: contact.id as string,
      context: { conversation_id: conversation.id as string, vars: payload },
    }).catch((err) => console.error('[automation-webhook] dispatch error:', err))

    // 12. Aceito — execução é assíncrona
    return NextResponse.json({ ok: true }, { status: 202 })
  } catch (err) {
    // Nunca logar o body nem o token (segurança)
    console.error('[automation-webhook] error:', err)
    return NextResponse.json({ error: 'Erro interno.' }, { status: 500 })
  }
}
