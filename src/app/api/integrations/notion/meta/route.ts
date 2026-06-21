import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/integrations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getDatabaseMeta, listNotionUsers } from '@/lib/integrations/notion'

export const runtime = 'nodejs'

// Devolve os campos preenchíveis da database Notion + usuários (Responsável),
// para o ShareModal montar os selects. Agente+ (config lida via service-role,
// pois a tabela é admin-only mas o agente precisa do token p/ enviar).
export async function GET() {
  try {
    const ctx = await requireRole('agent')
    const { data } = await supabaseAdmin()
      .from('integrations_config')
      .select('notion_api_key, notion_database_id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const cfg = data as { notion_api_key: string | null; notion_database_id: string | null } | null
    if (!cfg?.notion_api_key || !cfg?.notion_database_id) {
      return NextResponse.json({ configured: false, fields: [], users: [] })
    }

    let apiKey: string
    try {
      apiKey = decrypt(cfg.notion_api_key)
    } catch {
      return NextResponse.json(
        { error: 'Token do Notion corrompido — reconecte em Settings.' },
        { status: 400 },
      )
    }

    const [meta, users] = await Promise.all([
      getDatabaseMeta(apiKey, cfg.notion_database_id),
      listNotionUsers(apiKey).catch(() => []),
    ])

    return NextResponse.json({ configured: true, fields: meta.fields, users })
  } catch (err) {
    return toErrorResponse(err)
  }
}
