import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/broadcast/admin-client'
import { generateBroadcastWebhookToken } from '@/lib/broadcast/webhook-token'
import type { VariableMapping } from '@/lib/broadcast/variables'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

// Tipos de variável aceitos no blueprint (inclui 'payload' — materializada
// no clone pelo webhook público).
const VALID_VARIABLE_TYPES = ['static', 'field', 'custom_field', 'payload']

/**
 * Cria um broadcast BLUEPRINT (status 'webhook'): molde com template,
 * variáveis e filtro de audiência + token público gerado no servidor.
 * O disparo real acontece via POST /api/broadcasts/webhook/[token].
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Criação de blueprint é ação administrativa rara — bucket compartilhado.
  const limit = checkRateLimit(`blueprint:${user.id}`, RATE_LIMITS.adminAction)
  if (!limit.success) return rateLimitResponse(limit)

  // account_id obrigatório (espelha automations/route.ts)
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .single()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 403 },
    )
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const {
    name,
    connection_id,
    template_name,
    template_language,
    template_variables,
    audience_filter,
  } = body as {
    name?: string
    connection_id?: string
    template_name?: string
    template_language?: string
    template_variables?: Record<string, VariableMapping>
    audience_filter?: { type?: string; tagIds?: string[]; excludeTagIds?: string[] }
  }

  if (!name?.trim() || !template_name || !connection_id) {
    return NextResponse.json(
      { error: 'name, connection_id e template_name são obrigatórios.' },
      { status: 400 },
    )
  }

  // Webhook v1 só resolve audiência all/tags no disparo
  const audType = audience_filter?.type
  if (audType !== 'all' && audType !== 'tags') {
    return NextResponse.json(
      { error: 'Audiência do webhook precisa ser "Todos" ou "Tags".' },
      { status: 400 },
    )
  }

  // Variáveis com types válidos (payload incluído)
  for (const [key, v] of Object.entries(template_variables ?? {})) {
    if (!v || !VALID_VARIABLE_TYPES.includes(v.type) || typeof v.value !== 'string') {
      return NextResponse.json(
        { error: `Variável "${key}" com mapeamento inválido.` },
        { status: 400 },
      )
    }
  }

  const admin = supabaseAdmin()

  // Ownership da conexão: precisa pertencer à conta do caller
  const { data: conn } = await admin
    .from('whatsapp_config')
    .select('id')
    .eq('id', connection_id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!conn) {
    return NextResponse.json(
      { error: 'Conexão inválida para esta conta.' },
      { status: 400 },
    )
  }

  const webhook_token = generateBroadcastWebhookToken()

  // Shape espelha o INSERT do wizard (use-broadcast-sending.ts), com
  // status 'webhook' e contadores zerados — blueprint nunca envia direto.
  const { data: blueprint, error: insertErr } = await admin
    .from('broadcasts')
    .insert({
      user_id: user.id,
      account_id: accountId,
      connection_id,
      name: name.trim(),
      template_name,
      template_language: template_language ?? 'en_US',
      template_variables: template_variables ?? {},
      audience_filter: {
        type: audType,
        tagIds: audience_filter?.tagIds,
        excludeTagIds: audience_filter?.excludeTagIds,
      },
      status: 'webhook',
      scheduled_at: null,
      webhook_token,
      total_recipients: 0,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .select('id, webhook_token')
    .single()

  if (insertErr || !blueprint) {
    return NextResponse.json(
      { error: insertErr?.message ?? 'insert failed' },
      { status: 500 },
    )
  }

  return NextResponse.json(
    { id: blueprint.id, webhook_token: blueprint.webhook_token },
    { status: 201 },
  )
}
