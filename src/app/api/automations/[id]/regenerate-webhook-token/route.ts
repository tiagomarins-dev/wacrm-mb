import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { generateWebhookToken } from '@/lib/automations/webhook-token'

// Revoga o token do webhook e gera um novo — a URL antiga morre na hora.
// Auth por sessão + ownership por user_id (espelha [id]/duplicate).
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
  const { data: automation } = await admin
    .from('automations')
    .select('id, user_id, trigger_type')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!automation) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (automation.trigger_type !== 'webhook_received') {
    return NextResponse.json(
      { error: 'Automation has no webhook trigger' },
      { status: 400 },
    )
  }

  const webhook_token = generateWebhookToken()
  const { error } = await admin
    .from('automations')
    .update({ webhook_token })
    .eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ webhook_token })
}
