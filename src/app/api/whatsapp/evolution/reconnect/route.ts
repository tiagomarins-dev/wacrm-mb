// ============================================================
// Reconexão de uma conexão Evolution existente: consulta o estado da
// instância e devolve um QR novo p/ parear. Se a instância não existir
// mais no servidor, RECRIA com o MESMO instance_name — a row do banco é
// a dona do nome e o cursor de mensagens (last_evo_timestamp) sobrevive.
// POST porque muta (pode criar instância); o poll continua no GET
// /evolution/connect. O QR nunca é persistido. H1: row sempre escopada à
// conta + provider='evolution'; arquivadas ficam de fora (não ressuscitar
// sessão escondida da UI).
// ============================================================
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  evoConnectionState,
  evoConnect,
  evoCreateInstance,
  isEvoInstanceNotFound,
  isEvoNameInUse,
} from '@/lib/providers/evolution-api'

export const runtime = 'nodejs'

// Resolve a conta do caller pelo profile (mesmo padrão de connect/route.ts).
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

export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const body = (await request.json().catch(() => null)) as { connection_id?: string } | null
  const connectionId = body?.connection_id
  if (!connectionId) {
    return NextResponse.json({ error: 'connection_id obrigatório' }, { status: 400 })
  }

  // H1 + arquivada de fora: reconectar só conexão viva da própria conta.
  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('id, instance_name, evolution_base_url, status')
    .eq('id', connectionId)
    .eq('account_id', accountId)
    .eq('provider', 'evolution')
    .is('archived_at', null)
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

  // Sessão não-pareada → o banco reflete isso já; o poll do connect promove
  // de volta a 'connected' quando o pareamento concluir.
  const markDisconnected = async () => {
    if (config.status !== 'connected') return
    await supabase
      .from('whatsapp_config')
      .update({ status: 'disconnected', updated_at: new Date().toISOString() })
      .eq('id', config.id)
      .eq('account_id', accountId)
  }

  let state: string | null = null
  try {
    ;({ state } = await evoConnectionState({ baseUrl, apiKey, instance }))
  } catch (err) {
    if (!isEvoInstanceNotFound(err)) {
      return NextResponse.json(
        { error: `Falha ao reconectar na Evolution: ${err instanceof Error ? err.message : err}` },
        { status: 502 },
      )
    }
    // Instância apagada do servidor: recria com o mesmo nome e já devolve
    // o QR do create (mesmo payload do handleEvolutionConfig).
    try {
      const { qrBase64 } = await evoCreateInstance({ baseUrl, apiKey, instanceName: instance })
      await markDisconnected()
      return NextResponse.json({ status: 'pending', qr_base64: qrBase64, recreated: true })
    } catch (createErr) {
      // Corrida: alguém recriou entre o state e o create — segue p/ o
      // fluxo de QR da instância (agora) existente.
      if (!isEvoNameInUse(createErr)) {
        return NextResponse.json(
          { error: `Falha ao recriar a instância na Evolution: ${createErr instanceof Error ? createErr.message : createErr}` },
          { status: 502 },
        )
      }
    }
  }

  // Já pareada? marca conectada (idempotente, igual ao connect) e encerra.
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

  // close/connecting (ou pós-corrida): sincroniza o status e emite QR novo.
  await markDisconnected()
  try {
    const { qrBase64 } = await evoConnect({ baseUrl, apiKey, instance })
    return NextResponse.json({ status: 'pending', qr_base64: qrBase64, recreated: false })
  } catch (err) {
    return NextResponse.json(
      { error: `Falha ao reconectar na Evolution: ${err instanceof Error ? err.message : err}` },
      { status: 502 },
    )
  }
}
