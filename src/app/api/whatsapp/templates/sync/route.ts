import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'
import { syncConnectionTemplates } from '@/lib/whatsapp/template-sync'

/**
 * Sync message templates from Meta → local message_templates table.
 *
 * Multi-número (033): sincroniza os templates de CADA conexão da conta
 * (não só a primária). Para cada conexão com waba_id, busca os templates
 * da Meta com o token daquela conexão e grava escopado por connection_id.
 * Os contadores são agregados entre conexões e a resposta permanece PLANA
 * (total/inserted/updated/errors[]/truncated/success) — o front
 * (template-manager.tsx) consome exatamente esses campos.
 *
 * Locally-created templates (no Meta counterpart) are NOT deleted —
 * they remain visible so the user can notice drift and clean up.
 */
export async function POST() {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Resolve the caller's account_id — both whatsapp_config and
    // the message_templates we sync into are account-scoped.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Multi-número (033): lista TODAS as conexões da conta (sem
    // .maybeSingle(), que quebraria com 2+). Primária primeiro só por
    // determinismo de ordem.
    const { data: connections } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .order('is_primary', { ascending: false })

    if (!connections || connections.length === 0) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }

    // Agrega os contadores entre as conexões (resposta plana p/ o front).
    let total = 0
    let inserted = 0
    let updated = 0
    const errors: { name: string; language: string; message: string }[] = []
    let truncated = false

    for (const conn of connections) {
      // Conexão sem WABA não tem catálogo de templates — pula (não aborta).
      if (!conn.waba_id) {
        console.warn(`[templates/sync] conexão ${conn.id} sem waba_id — pulada`)
        continue
      }
      const accessToken = decrypt(conn.access_token)
      const r = await syncConnectionTemplates(
        supabase,
        { id: conn.id, waba_id: conn.waba_id, access_token: accessToken },
        accountId,
        user.id,
      )
      total += r.total
      inserted += r.inserted
      updated += r.updated
      errors.push(...r.errors)
      truncated = truncated || r.truncated
    }

    return NextResponse.json({
      success: errors.length === 0,
      total,
      inserted,
      updated,
      errors,
      truncated,
    })
  } catch (error) {
    console.error('Error syncing WhatsApp templates:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to sync templates',
      },
      { status: 500 },
    )
  }
}
