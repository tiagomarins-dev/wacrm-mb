import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/integrations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  summarizeConversation,
  BRIEFING_SUMMARY_PROMPT,
  BRIEFING_MESSAGE_LIMIT,
  type SummaryMessage,
} from '@/lib/integrations/openrouter'
import { redactPII } from '@/lib/integrations/redact'

// node:crypto (decrypt) → runtime Node.
export const runtime = 'nodejs'

// Decrypt que vira erro claro se o ENCRYPTION_KEY não bater (espelha share/route.ts:204).
function safeDecrypt(value: string): string {
  try {
    return decrypt(value)
  } catch {
    throw new Error('Token corrompido — reconecte a integração em Settings.')
  }
}

// Gera um BRIEFING on-demand da conversa (handoff p/ novo atendente). Não
// persiste nada. RLS-scoped via requireRole/ctx.supabase → sem IDOR. Espelha
// o preview do share/route.ts, mas com prompt dedicado e conversa "toda".
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent')
    const body = (await request.json()) as Record<string, unknown>
    const conversationId =
      typeof body.conversationId === 'string' ? body.conversationId : ''
    if (!conversationId)
      return NextResponse.json({ error: 'conversationId required' }, { status: 400 })

    // Config admin-only via service-role (o agente não lê por RLS, mas precisa da key).
    const { data: cfgData } = await supabaseAdmin()
      .from('integrations_config')
      .select('openrouter_api_key, openrouter_model')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const cfg = cfgData as
      | { openrouter_api_key: string | null; openrouter_model: string | null }
      | null
    const openrouterKey = cfg?.openrouter_api_key
      ? safeDecrypt(cfg.openrouter_api_key)
      : process.env.OPENROUTER_API_KEY || null
    if (!openrouterKey)
      return NextResponse.json(
        { error: 'OpenRouter não configurado. Peça a um admin para conectar.' },
        { status: 400 },
      )

    // Conversa + contato (RLS → garante mesma conta, sem IDOR).
    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('id, contact:contacts(*)')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv)
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contact = ((conv as any).contact ?? null) as { name?: string } | null

    // Conversa TODA (teto BRIEFING_MESSAGE_LIMIT). desc+limit → reverse cronológico.
    const { data: rawMsgs } = await ctx.supabase
      .from('messages')
      .select('sender_type, content_text, content_type, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(BRIEFING_MESSAGE_LIMIT)
    const truncated = (rawMsgs?.length ?? 0) === BRIEFING_MESSAGE_LIMIT
    const messages: SummaryMessage[] = (rawMsgs ?? [])
      .reverse()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((m: any) => ({
        sender_type: m.sender_type,
        // Redação: mascara email/telefone que o cliente tenha digitado.
        content_text: m.content_text ? redactPII(m.content_text) : m.content_text,
        content_type: m.content_type,
      }))
    if (messages.length === 0)
      return NextResponse.json({ error: 'Conversa sem mensagens' }, { status: 400 })

    // R1: nome de contato do WhatsApp às vezes é o próprio telefone → redigir.
    const firstName = contact?.name ? redactPII(contact.name.split(' ')[0]) : null

    const summary = await summarizeConversation({
      apiKey: openrouterKey,
      model: cfg?.openrouter_model,
      systemPrompt: BRIEFING_SUMMARY_PROMPT, // prompt dedicado (não o de share)
      messages,
      topic: 'Briefing do atendimento',
      firstName,
      messageLimit: BRIEFING_MESSAGE_LIMIT,
    })

    return NextResponse.json({ summary, truncated })
  } catch (error) {
    return toErrorResponse(error)
  }
}
