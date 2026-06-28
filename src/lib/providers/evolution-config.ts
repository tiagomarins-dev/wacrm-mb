// ============================================================
// CRUD da conexão Evolution (fase C). Mantém o config/route.ts magro:
// cria/reusa a instância na Evolution, monta a row e grava (INSERT/UPDATE),
// retornando o QR. Pula tudo que é Meta (verify/register/subscribe/dedup).
// access_token é um PLACEHOLDER cifrado — o Evolution autentica por
// EVOLUTION_API_KEY (chave global), nunca por token por-conexão.
// ============================================================
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/whatsapp/encryption'
import { evoCreateInstance } from './evolution-api'

interface HandleArgs {
  supabase: SupabaseClient
  accountId: string
  userId: string
  body: {
    connection_id?: string
    instance_name?: string
    evolution_base_url?: string | null
    label?: string | null
  }
}

// Cria/edita uma conexão Evolution e retorna o QR p/ parear via celular.
export async function handleEvolutionConfig({
  supabase,
  accountId,
  userId,
  body,
}: HandleArgs): Promise<Response> {
  const instanceName = typeof body.instance_name === 'string' ? body.instance_name.trim() : ''
  if (!instanceName) {
    return NextResponse.json(
      { error: 'instance_name é obrigatório para conexões Evolution.' },
      { status: 400 },
    )
  }

  const baseUrl = body.evolution_base_url || process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY
  if (!baseUrl || !apiKey) {
    return NextResponse.json(
      { error: 'Evolution não configurada no servidor (EVOLUTION_API_URL/KEY).' },
      { status: 503 },
    )
  }

  // Edição: carrega a conexão existente SEMPRE escopada à conta (H1).
  const { data: existing } = body.connection_id
    ? await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('id', body.connection_id)
        .eq('account_id', accountId)
        .maybeSingle()
    : { data: null }

  // Cria (ou reusa) a instância na Evolution e já pega o QR.
  let qrBase64: string | null = null
  try {
    const r = await evoCreateInstance({ baseUrl, apiKey, instanceName })
    qrBase64 = r.qrBase64
  } catch (err) {
    return NextResponse.json(
      { error: `Falha ao criar instância na Evolution: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    )
  }

  // Row da conexão. phone_number_id/waba_id ficam NULL (Evolution não tem).
  // access_token = placeholder cifrado (coluna NOT NULL; nunca usado p/ Evolution).
  const baseRow = {
    provider: 'evolution',
    instance_name: instanceName,
    evolution_base_url: body.evolution_base_url || null,
    phone_number_id: null,
    waba_id: null,
    access_token: encrypt('evolution'),
    label: (typeof body.label === 'string' ? body.label.trim() : '') || null,
    status: 'disconnected',
    updated_at: new Date().toISOString(),
  }

  if (existing) {
    const { error } = await supabase
      .from('whatsapp_config')
      .update(baseRow)
      .eq('id', existing.id)
      .eq('account_id', accountId)
    if (error) {
      return NextResponse.json({ error: 'Failed to update Evolution connection' }, { status: 500 })
    }
    return NextResponse.json({ success: true, provider: 'evolution', connection_id: existing.id, qr_base64: qrBase64 })
  }

  // Nova conexão: a 1ª da conta vira primária (igual ao fluxo Meta).
  const { count } = await supabase
    .from('whatsapp_config')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
  const isPrimary = (count ?? 0) === 0

  const { data: inserted, error } = await supabase
    .from('whatsapp_config')
    .insert({ account_id: accountId, user_id: userId, is_primary: isPrimary, ...baseRow })
    .select('id')
    .single()
  if (error || !inserted) {
    return NextResponse.json({ error: 'Failed to create Evolution connection' }, { status: 500 })
  }
  return NextResponse.json({ success: true, provider: 'evolution', connection_id: inserted.id, qr_base64: qrBase64 })
}
