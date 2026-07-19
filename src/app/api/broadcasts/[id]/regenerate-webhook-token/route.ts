import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/broadcast/admin-client'
import { generateBroadcastWebhookToken } from '@/lib/broadcast/webhook-token'

// Revoga o token do blueprint e gera um novo — a URL antiga morre na hora.
// Espelho 1:1 do regenerate de automations (sessão + ownership por user_id).
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = supabaseAdmin()
  const { data: broadcast } = await admin
    .from('broadcasts')
    .select('id, user_id, status')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!broadcast) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (broadcast.status !== 'webhook') {
    return NextResponse.json(
      { error: 'Broadcast is not a webhook blueprint' },
      { status: 400 },
    )
  }

  const webhook_token = generateBroadcastWebhookToken()
  const { error } = await admin
    .from('broadcasts')
    .update({ webhook_token })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ webhook_token })
}
