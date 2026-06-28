import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'
import type { IntegrationsConfigPublic } from '@/types'

export const runtime = 'nodejs'

// Config de integrações (OpenRouter/Notion/Slack), account-level, admin-only.
// Tokens criptografados app-side; nunca retornados ao client. RLS já restringe
// a tabela a admin+; requireRole('admin') é a 2ª camada.

interface ConfigRow {
  openrouter_api_key: string | null
  openrouter_model: string | null
  openrouter_summary_prompt: string | null
  notion_api_key: string | null
  notion_database_id: string | null
  slack_bot_token: string | null
  slack_channel_id: string | null
  millaborges_api_key: string | null
  // Transcrição de áudio (migration 046) — não-secretos.
  transcription_enabled: boolean | null
  transcription_model: string | null
  transcription_fallback_model: string | null
  transcription_format_model: string | null
  // Janela de atribuição de venda em dias (Fase 2).
  mb_attribution_window_days: number | null
}

function toPublic(row: ConfigRow | null): IntegrationsConfigPublic {
  return {
    openrouter_model: row?.openrouter_model ?? null,
    openrouter_summary_prompt: row?.openrouter_summary_prompt ?? null,
    notion_database_id: row?.notion_database_id ?? null,
    slack_channel_id: row?.slack_channel_id ?? null,
    openrouter_set: !!row?.openrouter_api_key,
    notion_set: !!row?.notion_api_key,
    slack_set: !!row?.slack_bot_token,
    millaborges_set: !!row?.millaborges_api_key,
    transcription_enabled: row?.transcription_enabled ?? true,
    transcription_model: row?.transcription_model ?? null,
    transcription_fallback_model: row?.transcription_fallback_model ?? null,
    transcription_format_model: row?.transcription_format_model ?? null,
    mb_attribution_window_days: row?.mb_attribution_window_days ?? 30,
  }
}

// GET — devolve config pública (sem tokens).
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const { data } = await ctx.supabase
      .from('integrations_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    return NextResponse.json(toPublic((data as ConfigRow | null) ?? null))
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST — salva (upsert). Tokens: só atualiza quando vêm preenchidos (não
// mascarados). Campos não-secretos sempre atualizados quando enviados.
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = (await request.json()) as Record<string, unknown>

    const str = (v: unknown) =>
      typeof v === 'string' && v.trim() ? v.trim() : null

    // Carrega o existente p/ não apagar tokens não-editados.
    const { data: existing } = await ctx.supabase
      .from('integrations_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const cur = (existing as ConfigRow | null) ?? null

    // Token só muda se veio um valor novo (não vazio); senão mantém o atual.
    const tokenField = (incoming: unknown, currentEnc: string | null) => {
      const v = str(incoming)
      return v ? encrypt(v) : currentEnc
    }

    // Janela de atribuição: aceita int 1..365 quando enviado; ausente = mantém atual.
    const windowField = (incoming: unknown, current: number): number | 'invalid' => {
      if (incoming === undefined || incoming === null) return current
      if (typeof incoming === 'number' && Number.isInteger(incoming) && incoming >= 1 && incoming <= 365) return incoming
      return 'invalid'
    }
    const mbWindow = windowField(body.mb_attribution_window_days, cur?.mb_attribution_window_days ?? 30)
    if (mbWindow === 'invalid') {
      return NextResponse.json(
        { error: 'Janela de atribuição deve ser um inteiro entre 1 e 365.' },
        { status: 400 },
      )
    }

    const payload = {
      account_id: ctx.accountId,
      openrouter_api_key: tokenField(body.openrouter_api_key, cur?.openrouter_api_key ?? null),
      openrouter_model: str(body.openrouter_model),
      openrouter_summary_prompt: str(body.openrouter_summary_prompt),
      notion_api_key: tokenField(body.notion_api_key, cur?.notion_api_key ?? null),
      notion_database_id: str(body.notion_database_id),
      slack_bot_token: tokenField(body.slack_bot_token, cur?.slack_bot_token ?? null),
      slack_channel_id: str(body.slack_channel_id),
      millaborges_api_key: tokenField(body.millaborges_api_key, cur?.millaborges_api_key ?? null),
      // Transcrição: model ids plaintext via str(); enabled por coerção própria
      // (str() devolve null p/ boolean).
      transcription_enabled:
        typeof body.transcription_enabled === 'boolean' ? body.transcription_enabled : true,
      transcription_model: str(body.transcription_model),
      transcription_fallback_model: str(body.transcription_fallback_model),
      transcription_format_model: str(body.transcription_format_model),
      mb_attribution_window_days: mbWindow,
    }

    // Validação leve: token sem o campo-companheiro não adianta.
    if (payload.notion_api_key && !payload.notion_database_id) {
      return NextResponse.json(
        { error: 'Notion: informe também o Database ID.' },
        { status: 400 },
      )
    }
    if (payload.slack_bot_token && !payload.slack_channel_id) {
      return NextResponse.json(
        { error: 'Slack: informe também o Channel ID.' },
        { status: 400 },
      )
    }

    const { error } = await ctx.supabase
      .from('integrations_config')
      .upsert(payload, { onConflict: 'account_id' })
    if (error) {
      console.error('[integrations/config] upsert failed:', error.message)
      return NextResponse.json({ error: 'Failed to save config' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// DELETE — limpa um provedor (?provider=openrouter|notion|slack) ou a config
// inteira (sem param). Útil quando um token corrompe/expira.
export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const provider = new URL(request.url).searchParams.get('provider')

    if (!provider) {
      await ctx.supabase
        .from('integrations_config')
        .delete()
        .eq('account_id', ctx.accountId)
      return NextResponse.json({ success: true })
    }

    const clear: Record<string, null> =
      provider === 'openrouter'
        ? { openrouter_api_key: null, openrouter_model: null, openrouter_summary_prompt: null }
        : provider === 'notion'
          ? { notion_api_key: null, notion_database_id: null }
          : provider === 'slack'
            ? { slack_bot_token: null, slack_channel_id: null }
            : {}
    if (Object.keys(clear).length === 0) {
      return NextResponse.json({ error: 'Unknown provider' }, { status: 400 })
    }
    await ctx.supabase
      .from('integrations_config')
      .update(clear)
      .eq('account_id', ctx.accountId)
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
