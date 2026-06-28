// ============================================================
// Poll do QR / estado de uma conexão Evolution (fase C). H1: carrega a
// conexão SEMPRE escopada à conta (+ provider='evolution'). state='open'
// → marca conectada; senão re-emite o QR. O base64 NUNCA é persistido.
// ============================================================
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { evoConnectionState, evoConnect } from '@/lib/providers/evolution-api'

export const runtime = 'nodejs'

// Resolve a conta do caller pelo profile (mesmo padrão de config/route.ts).
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  return (data?.account_id as string) ?? null
}

export async function GET(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const connectionId = new URL(request.url).searchParams.get('connection_id')
  if (!connectionId) {
    return NextResponse.json({ error: 'connection_id obrigatório' }, { status: 400 })
  }

  // H1: a conexão tem que ser da conta E do provider evolution.
  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('id, instance_name, evolution_base_url, status')
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .maybeSingle()

  if (!config?.instance_name) {
    return NextResponse.json({ error: 'Conexão Evolution não encontrada' }, { status: 404 })
  }

  const baseUrl = config.evolution_base_url || process.env.EVOLUTION_API_URL
  const apiKey = process.env.EVOLUTION_API_KEY
  if (!baseUrl || !apiKey) {
    return NextResponse.json({ error: 'Evolution não configurada no servidor' }, { status: 503 })
  }
  const instance = config.instance_name

  // Conectada? marca status (idempotente) e encerra o poll.
  const { state } = await evoConnectionState({ baseUrl, apiKey, instance })
  if (state === 'open') {
    if (config.status !== 'connected') {
      await supabase
        .from('whatsapp_config')
        .update({ status: 'connected', connected_at: new Date().toISOString() })
        .eq('id', config.id)
        .eq('account_id', accountId)
    }
    return NextResponse.json({ status: 'connected' })
  }

  // Ainda não pareada — devolve um QR novo (expira ~60s; não persistir).
  const { qrBase64 } = await evoConnect({ baseUrl, apiKey, instance })
  return NextResponse.json({ status: 'pending', qr_base64: qrBase64 })
}
