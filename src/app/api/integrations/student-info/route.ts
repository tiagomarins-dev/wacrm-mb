import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/integrations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { fetchStudentInfo, type StudentInfoResponse } from '@/lib/integrations/student-info'

export const runtime = 'nodejs'

// Proxy server-to-server da API "Info Aluno" (Millaborges). Lê o contato via
// client RLS-scoped (sem IDOR), a key admin-only via service-role, chama a API
// e salva um snapshot por contato. Em falha da API, devolve o último snapshot
// (stale) — o "salvar no banco" também vira resiliência. A key nunca vai ao front.
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const { contactId } = (await request.json()) as { contactId?: string }
    if (!contactId)
      return NextResponse.json({ error: 'contactId required' }, { status: 400 })

    // Contato via RLS (mesma conta → sem IDOR).
    const { data: contact } = await ctx.supabase
      .from('contacts')
      .select('email, phone')
      .eq('id', contactId)
      .maybeSingle()
    if (!contact)
      return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
    const c = contact as { email: string | null; phone: string | null }
    if (!c.email && !c.phone)
      return NextResponse.json({ status: 'no_identifier' })

    // Key (admin-only) via service-role; env como fallback.
    const { data: cfg } = await supabaseAdmin()
      .from('integrations_config')
      .select('millaborges_api_key')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const enc = (cfg as { millaborges_api_key: string | null } | null)?.millaborges_api_key
    let apiKey: string | null = null
    if (enc) {
      try {
        apiKey = decrypt(enc)
      } catch {
        apiKey = null
      }
    }
    apiKey = apiKey || process.env.API_ALUNO_KEY || null
    if (!apiKey) return NextResponse.json({ configured: false })

    try {
      const data = await fetchStudentInfo({ apiKey, email: c.email, phone: c.phone })
      // Salva snapshot só p/ status "normais" (não sobrescreve um bom com erro).
      if (['success', 'nao_encontrado', 'multiplos'].includes(data.status)) {
        await supabaseAdmin()
          .from('student_info')
          .upsert(
            {
              account_id: ctx.accountId,
              contact_id: contactId,
              status: data.status,
              matched_by: data.matched_by ?? null,
              payload: data,
              fetched_at: new Date().toISOString(),
            },
            { onConflict: 'account_id,contact_id' },
          )
      }
      return NextResponse.json({ configured: true, ...data })
    } catch (e) {
      // API falhou (timeout/429/5xx) → devolve o último snapshot salvo (stale).
      const { data: snap } = await supabaseAdmin()
        .from('student_info')
        .select('payload, fetched_at')
        .eq('account_id', ctx.accountId)
        .eq('contact_id', contactId)
        .maybeSingle()
      const s = snap as { payload: StudentInfoResponse; fetched_at: string } | null
      if (s?.payload)
        return NextResponse.json({ configured: true, stale: true, fetched_at: s.fetched_at, ...s.payload })
      console.error('[student-info] falhou e sem snapshot:', e instanceof Error ? e.message : e)
      return NextResponse.json({ configured: true, status: 'erro' })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
