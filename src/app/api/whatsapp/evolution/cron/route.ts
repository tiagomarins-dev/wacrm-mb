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
 * (conversation_id, message_id) via SELECT + índice único (057). NÃO
 * dispara IA/flows/automações (fora do escopo D).
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
      // de contato existente.
      let conversation
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

      const { error: insErr } = await admin.from('messages').insert({
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
