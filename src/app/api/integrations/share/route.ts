import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/integrations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  summarizeConversation,
  SHARE_MESSAGE_LIMIT,
  type SummaryMessage,
} from '@/lib/integrations/openrouter'
import { redactPII } from '@/lib/integrations/redact'
import { buildContactBlock } from '@/lib/integrations/contact-block'
import {
  createNotionPage,
  type NotionPropAssignment,
} from '@/lib/integrations/notion'
import { postSlackMessage } from '@/lib/integrations/slack'

export const runtime = 'nodejs'

const PROVIDERS = ['notion', 'slack'] as const
const MODES = ['preview', 'send'] as const
const TOPIC_MAX = 200
const NOTE_MAX = 500
const SUMMARY_MAX = 5000

type Provider = (typeof PROVIDERS)[number]

interface ConfigRow {
  openrouter_api_key: string | null
  openrouter_model: string | null
  openrouter_summary_prompt: string | null
  notion_api_key: string | null
  notion_database_id: string | null
  slack_bot_token: string | null
  slack_channel_id: string | null
}

export async function POST(request: Request) {
  try {
    // Agentes+ podem compartilhar. ctx.supabase é RLS-scoped → o agente só
    // alcança conversas/mensagens da própria conta (sem IDOR).
    const ctx = await requireRole('agent')
    const body = (await request.json()) as Record<string, unknown>

    const provider = body.provider as Provider
    const mode = body.mode as (typeof MODES)[number]
    const conversationId = body.conversationId as string
    const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
    const note = typeof body.note === 'string' ? body.note.trim() : ''

    if (!PROVIDERS.includes(provider))
      return NextResponse.json({ error: 'Invalid provider' }, { status: 400 })
    if (!MODES.includes(mode))
      return NextResponse.json({ error: 'Invalid mode' }, { status: 400 })
    if (!conversationId)
      return NextResponse.json({ error: 'conversationId required' }, { status: 400 })
    if (!topic)
      return NextResponse.json({ error: 'topic required' }, { status: 400 })
    if (topic.length > TOPIC_MAX || note.length > NOTE_MAX)
      return NextResponse.json({ error: 'topic/note too long' }, { status: 400 })

    // ── Config (admin-only) via service-role: o agente não a lê por RLS,
    //    mas precisa dos tokens p/ enviar. ─────────────────────────────
    const { data: cfgData } = await supabaseAdmin()
      .from('integrations_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    const cfg = (cfgData as ConfigRow | null) ?? null

    const openrouterKey = cfg?.openrouter_api_key
      ? safeDecrypt(cfg.openrouter_api_key)
      : process.env.OPENROUTER_API_KEY || null
    if (!openrouterKey)
      return NextResponse.json(
        { error: 'OpenRouter não configurado. Peça a um admin para conectar.' },
        { status: 400 },
      )

    // ── Conversa + contato (RLS-scoped → garante mesma conta) ──────────
    const { data: conv } = await ctx.supabase
      .from('conversations')
      .select('id, contact:contacts(*)')
      .eq('id', conversationId)
      .maybeSingle()
    if (!conv)
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contact = ((conv as any).contact ?? null) as
      | { name?: string; phone?: string; email?: string; company?: string }
      | null

    // Últimas N mensagens (desc + limit, depois cronológico).
    const { data: rawMsgs } = await ctx.supabase
      .from('messages')
      .select('sender_type, content_text, content_type, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(SHARE_MESSAGE_LIMIT)
    const messages: SummaryMessage[] = (rawMsgs ?? [])
      .reverse()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((m: any) => ({
        sender_type: m.sender_type,
        // Redação: mascara email/telefone que o cliente tenha digitado.
        content_text: m.content_text ? redactPII(m.content_text) : m.content_text,
        content_type: m.content_type,
      }))

    const firstName = contact?.name ? contact.name.split(' ')[0] : null

    // ── PREVIEW: só gera o resumo (sem enviar) ─────────────────────────
    const aiSummary = await summarizeConversation({
      apiKey: openrouterKey,
      model: cfg?.openrouter_model,
      systemPrompt: cfg?.openrouter_summary_prompt,
      messages,
      topic: note ? `${topic} — ${note}` : topic,
      firstName,
    })

    if (mode === 'preview') {
      return NextResponse.json({ summary: aiSummary })
    }

    // ── SEND: usa o resumo (possivelmente editado) + bloco de contato ──
    const editedSummary =
      typeof body.summary === 'string' && body.summary.trim()
        ? body.summary.trim().slice(0, SUMMARY_MAX)
        : aiSummary

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '')
    const convUrl = siteUrl ? `${siteUrl}/inbox?c=${conversationId}` : null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contactBlock = buildContactBlock(contact as any, convUrl)
    const finalText = `${editedSummary}\n\n---\n${contactBlock}`

    // Registra a tentativa (pending) antes da chamada externa.
    const { data: share } = await ctx.supabase
      .from('conversation_shares')
      .insert({
        account_id: ctx.accountId,
        conversation_id: conversationId,
        user_id: ctx.userId,
        provider,
        topic,
        status: 'pending',
      })
      .select('id')
      .single()
    const shareId = share?.id as string | undefined

    try {
      let externalUrl: string | null = null
      if (provider === 'notion') {
        if (!cfg?.notion_api_key || !cfg?.notion_database_id)
          throw new Error('Notion não configurado')
        // Campos extras escolhidos no modal (Categoria/Área/Prioridade/
        // Status/Responsável/Prazo). buildProperty ignora vazios/tipos
        // desconhecidos — confiar no shape do modal é seguro.
        const extraProps = Array.isArray(body.notionProperties)
          ? (body.notionProperties as NotionPropAssignment[]).slice(0, 20)
          : []
        const r = await createNotionPage({
          apiKey: safeDecrypt(cfg.notion_api_key),
          databaseId: cfg.notion_database_id,
          title: `${topic}${firstName ? ` — ${firstName}` : ''}`,
          body: finalText,
          extraProps,
        })
        externalUrl = r.url
      } else {
        if (!cfg?.slack_bot_token || !cfg?.slack_channel_id)
          throw new Error('Slack não configurado')
        await postSlackMessage({
          botToken: safeDecrypt(cfg.slack_bot_token),
          channelId: cfg.slack_channel_id,
          text: `*${topic}*\n${finalText}`,
        })
      }

      if (shareId)
        await ctx.supabase
          .from('conversation_shares')
          .update({ status: 'sent', external_url: externalUrl })
          .eq('id', shareId)

      return NextResponse.json({ success: true, external_url: externalUrl })
    } catch (sendErr) {
      const msg = sendErr instanceof Error ? sendErr.message : 'send failed'
      if (shareId)
        await ctx.supabase
          .from('conversation_shares')
          .update({ status: 'failed', error_message: msg })
          .eq('id', shareId)
      return NextResponse.json({ error: msg }, { status: 502 })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Decrypt que vira erro claro se o ENCRYPTION_KEY não bater (token corrompido). */
function safeDecrypt(value: string): string {
  try {
    return decrypt(value)
  } catch {
    throw new Error('Token corrompido — reconecte a integração em Settings.')
  }
}
