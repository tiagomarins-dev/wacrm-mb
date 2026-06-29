import { timingSafeEqual, randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/broadcast/admin-client'
import { evoFetchMessages, evoBase64FromMedia, evoFetchGroupSubject } from '@/lib/providers/evolution-api'
import { normalizeEvolutionInbound } from '@/lib/providers/evolution-inbound'
import {
  findOrCreateContact,
  findOrCreateConversation,
  findOrCreateGroupConversation,
} from '@/lib/whatsapp/inbound'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiAgent } from '@/lib/ai-agent/dispatch'
import { dispatchTranscription } from '@/lib/transcription/dispatch'

// node:crypto + service-role → runtime Node.
export const runtime = 'nodejs'

const MEDIA_BUCKET = 'chat-media'
const MAX_MEDIA_BYTES = 16 * 1024 * 1024 // 16MB
// MIME aceitos no inbound de mídia (allowlist — V3).
const ALLOWED_MEDIA_PREFIX = ['image/', 'audio/', 'video/', 'application/']

// Sobe a mídia (base64) no bucket chat-media via service-role e devolve a URL
// pública. Valida MIME (allowlist) e tamanho. Path account-scoped (mesma
// convenção de upload-media.ts). Retorna null se inválida/falha.
async function uploadEvolutionMedia(
  admin: SupabaseClient,
  accountId: string,
  media: { base64: string; mimetype: string },
): Promise<string | null> {
  if (!ALLOWED_MEDIA_PREFIX.some((p) => media.mimetype.startsWith(p))) return null
  const buffer = Buffer.from(media.base64, 'base64')
  if (buffer.length === 0 || buffer.length > MAX_MEDIA_BYTES) return null
  const ext = (media.mimetype.split('/')[1] || 'bin').split(';')[0]
  const path = `account-${accountId}/${Date.now()}-${randomUUID()}.${ext}`
  const { error } = await admin.storage
    .from(MEDIA_BUCKET)
    .upload(path, buffer, { contentType: media.mimetype, upsert: false })
  if (error) return null
  return admin.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl
}

/**
 * Cron de inbound da Evolution (fase D). Batido pelo sidecar com header
 * x-cron-secret. Por tick: lista conexões evolution conectadas, puxa as
 * mensagens novas (poll), normaliza, reusa findOrCreate* (inbound.ts) e
 * grava em messages — isolado por connection_id. Idempotente: dedup por
 * (conversation_id, message_id) via SELECT + índice único (057).
 * O ramo 1:1 dispara flows/automações/IA/transcrição (paridade com o
 * webhook Meta). Grupos (@g.us) NÃO disparam engines (Fase E).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // Conexões Evolution conectadas (de todas as contas).
  const { data: conns, error: connErr } = await admin
    .from('whatsapp_config')
    .select('id, account_id, user_id, instance_name, evolution_base_url, last_evo_timestamp')
    .eq('provider', 'evolution')
    .eq('status', 'connected')

  if (connErr) {
    return NextResponse.json({ error: connErr.message }, { status: 500 })
  }

  const apiKey = process.env.EVOLUTION_API_KEY
  let imported = 0
  const perInstance: { instance: string; imported: number }[] = []

  for (const conn of conns ?? []) {
    const baseUrl = conn.evolution_base_url ?? process.env.EVOLUTION_API_URL
    if (!baseUrl || !apiKey || !conn.instance_name) continue

    let records
    try {
      records = await evoFetchMessages({ baseUrl, apiKey, instance: conn.instance_name })
    } catch (err) {
      console.error('[evolution/cron] fetch failed', conn.instance_name, err instanceof Error ? err.message : err)
      continue
    }

    const cursor = conn.last_evo_timestamp ?? 0
    let maxTs = cursor
    let n = 0

    for (const rec of records) {
      const norm = normalizeEvolutionInbound(rec)
      // Pula tipo não suportado, eco próprio (fromMe) e já visto (cursor).
      if (!norm || norm.fromMe) continue
      if (cursor && norm.timestamp <= cursor) continue

      // Grupo (058): conversa por chat_id, sem contato. 1:1 segue o caminho
      // de contato existente. contactId/wasCreated ficam no escopo do loop
      // p/ o dispatch pós-insert (só 1:1; grupo deixa null → sem dispatch).
      let conversation
      let contactId: string | null = null
      let wasCreated = false
      if (norm.isGroup && norm.chatId) {
        // Nome do grupo best-effort (não vem no record); fallback "Grupo" na UI.
        const groupName = await evoFetchGroupSubject({
          baseUrl, apiKey, instance: conn.instance_name, groupJid: norm.chatId,
        })
        conversation = await findOrCreateGroupConversation(
          admin, conn.account_id, conn.user_id, conn.id, norm.chatId, groupName,
        )
      } else {
        const contactOutcome = await findOrCreateContact(
          admin, conn.account_id, conn.user_id, conn.id, norm.phone, norm.name,
        )
        if (!contactOutcome) continue
        contactId = contactOutcome.contact.id
        wasCreated = contactOutcome.wasCreated
        conversation = await findOrCreateConversation(
          admin, conn.account_id, conn.user_id, conn.id, contactOutcome.contact.id,
        )
      }
      if (!conversation) continue

      // Dedup (idempotência): se a msg já existe nessa conversa, pula.
      const { data: dup } = await admin
        .from('messages')
        .select('id')
        .eq('conversation_id', conversation.id)
        .eq('message_id', norm.messageId)
        .maybeSingle()
      if (dup) {
        if (norm.timestamp > maxTs) maxTs = norm.timestamp
        continue
      }

      // Primeira msg do contato? Conta ANTES de inserir (precisão). Só 1:1.
      // Espelha o webhook (route.ts:602-607) — pega contato importado que
      // responde pela 1ª vez, que new_contact_created não cobriria.
      let isFirstInboundMessage = false
      if (!norm.isGroup && contactId) {
        const { count } = await admin
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('conversation_id', conversation.id)
          .eq('sender_type', 'customer')
        isFirstInboundMessage = (count ?? 0) === 0
      }

      // Mídia: baixa base64 e sobe no bucket (falha de mídia não derruba o texto).
      let mediaUrl: string | null = null
      if (norm.hasMedia) {
        try {
          const media = await evoBase64FromMedia({
            baseUrl, apiKey, instance: conn.instance_name, messageKeyId: norm.messageId,
          })
          if (media) mediaUrl = await uploadEvolutionMedia(admin, conn.account_id, media)
        } catch (err) {
          console.error('[evolution/cron] media failed', norm.messageId, err instanceof Error ? err.message : err)
        }
      }

      // .select('id').single() captura o UUID da linha (inserted.id) p/ a
      // transcrição. ⚠️ inserted.id é o id do BANCO — a IA usa o wamid
      // (norm.messageId), nunca isto.
      const { data: inserted, error: insErr } = await admin
        .from('messages')
        .insert({
          conversation_id: conversation.id,
          sender_type: 'customer',
          // Grupo: nome do participante remetente (058); NULL em 1:1.
          sender_name: norm.senderName,
          content_type: norm.contentType,
          content_text: norm.contentText,
          media_url: mediaUrl,
          message_id: norm.messageId,
          status: 'delivered',
          created_at: new Date(norm.timestamp * 1000).toISOString(),
          transcription_status: norm.contentType === 'audio' ? 'pending' : null,
        })
        .select('id')
        .single()
      // Índice único (057) é o backstop: corrida concorrente vira no-op.
      if (insErr) {
        if (norm.timestamp > maxTs) maxTs = norm.timestamp
        continue
      }

      // Atualiza a conversa (espelha o webhook): última msg + não-lidas.
      await admin
        .from('conversations')
        .update({
          last_message_text: norm.contentText || `[${norm.contentType}]`,
          last_message_at: new Date().toISOString(),
          unread_count: (conversation.unread_count || 0) + 1,
          updated_at: new Date().toISOString(),
        })
        .eq('id', conversation.id)

      // Dispatch de engines igual ao webhook Meta — SÓ no ramo 1:1 (grupo é
      // Fase E). Reusa os mesmos dispatchers; nenhuma lógica de engine nova.
      if (!norm.isGroup && contactId) {
        const inboundText = norm.contentText ?? ''

        // 1) Flows (awaited): `consumed` decide se suprime os triggers de
        //    conteúdo. try/catch local isola falha desta conexão das demais
        //    do loop (o runner já tem try/catch interno; isto é defesa extra).
        let flowConsumed = false
        try {
          const flowResult = await dispatchInboundToFlows({
            accountId: conn.account_id,
            connectionId: conn.id,
            userId: conn.user_id,
            contactId,
            conversationId: conversation.id,
            // Evolution não tem reply interativo → sempre kind:'text'.
            message: { kind: 'text', text: inboundText, meta_message_id: norm.messageId },
            isFirstInboundMessage,
          })
          flowConsumed = flowResult.consumed
        } catch (e) {
          console.error('[evolution/cron] flows dispatch:', e instanceof Error ? e.message : e)
        }

        // 2) Automações (fire-and-forget). Mesma montagem/ordem do webhook:
        //    triggers de conteúdo suprimidos se o flow consumiu; os de
        //    relacionamento (novo contato / 1ª msg) sempre disparam.
        const automationTriggers: (
          | 'new_contact_created' | 'first_inbound_message'
          | 'new_message_received' | 'keyword_match'
        )[] = []
        if (!flowConsumed) automationTriggers.push('new_message_received', 'keyword_match')
        if (wasCreated) automationTriggers.unshift('new_contact_created')
        if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
        for (const triggerType of automationTriggers) {
          runAutomationsForTrigger({
            accountId: conn.account_id,
            connectionId: conn.id,
            triggerType,
            contactId,
            context: { message_text: inboundText, conversation_id: conversation.id },
          }).catch((err) => console.error('[automations] dispatch failed:', err))
        }

        // 3) Agente de IA (fire-and-forget). inboundMessageId = wamid
        //    (norm.messageId), NÃO inserted.id — é o id do provedor, usado p/
        //    o indicador "digitando…" e gravado em ai_agent_pending.
        dispatchInboundToAiAgent({
          accountId: conn.account_id,
          connectionId: conn.id,
          contactId,
          conversationId: conversation.id,
          inboundMessageId: norm.messageId,
          flowConsumed,
        }).catch((err) => console.error('[ai_agent] dispatch failed:', err))

        // 4) Transcrição (fire-and-forget, só áudio). Usa o UUID da linha.
        if (norm.contentType === 'audio' && mediaUrl) {
          void dispatchTranscription({
            db: admin,
            messageId: inserted.id,
            accountId: conn.account_id,
            conversationId: conversation.id,
            connectionId: conn.id,
            mediaUrl,
          }).catch((e) => console.error('[transcription] inbound:', (e as Error).message))
        }
      }

      n++
      if (norm.timestamp > maxTs) maxTs = norm.timestamp
    }

    // Avança o cursor da conexão (otimização do próximo poll).
    if (maxTs > cursor) {
      await admin.from('whatsapp_config').update({ last_evo_timestamp: maxTs }).eq('id', conn.id)
    }
    imported += n
    perInstance.push({ instance: conn.instance_name, imported: n })
  }

  return NextResponse.json({ imported, perInstance })
}
