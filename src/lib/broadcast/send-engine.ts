import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { sendRecipients, type BroadcastRecipientInput } from './send-batch'
import {
  resolveVariables,
  fetchCustomValueIndex,
  type VariableMapping,
} from './variables'

/** Linha de broadcast necessária para o engine (subset de `broadcasts`). */
export interface ScheduledBroadcastRow {
  id: string
  account_id: string
  template_name: string
  template_language: string | null
  template_variables: Record<string, VariableMapping> | null
}

export interface DrainResult {
  /** Recipients enviados com sucesso neste tick. */
  sent: number
  /** Recipients falhos neste tick. */
  failed: number
  /** Ainda restam recipients pending nesta broadcast após o tick? */
  hasMore: boolean
  /** A broadcast foi finalizada (sent/failed) neste tick? */
  finalized: boolean
}

/**
 * Drena até `limit` recipients pendentes de UMA broadcast e envia via Meta.
 * Server-only (usa client service-role). Isolamento de tenant: carrega o
 * whatsapp_config PELO account_id da broadcast — nunca global. Idempotente:
 * só toca recipients 'pending', então um tick interrompido é retomado no
 * próximo. Contadores do broadcast saem do trigger agregado (migration 005);
 * aqui só mudamos status de recipient/broadcast.
 */
export async function drainBroadcast(
  admin: SupabaseClient,
  broadcast: ScheduledBroadcastRow,
  limit: number,
): Promise<DrainResult> {
  const language = broadcast.template_language || 'en_US'

  // ── Config do tenant (isolamento) ──────────────────────────────
  const { data: config } = await admin
    .from('whatsapp_config')
    .select('phone_number_id, access_token')
    .eq('account_id', broadcast.account_id)
    .maybeSingle()

  // ── Carrega até `limit` recipients pendentes (+ contato) ───────
  const { data: pending, error: pendErr } = await admin
    .from('broadcast_recipients')
    .select('id, contact:contacts(*)')
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')
    .limit(limit)

  if (pendErr) {
    console.error(`[broadcast-cron] fetch pending failed ${broadcast.id}:`, pendErr.message)
    return { sent: 0, failed: 0, hasMore: true, finalized: false }
  }

  const batch = pending ?? []

  // Sem config/token válido: marca este lote como falho e finaliza a
  // broadcast como 'failed' (não fica em loop reprocessando).
  if (!config?.phone_number_id || !config?.access_token) {
    if (batch.length > 0) {
      await admin
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: 'WhatsApp not configured for this account' })
        .in('id', batch.map((r) => r.id))
    }
    await admin.from('broadcasts').update({ status: 'failed' }).eq('id', broadcast.id)
    return { sent: 0, failed: batch.length, hasMore: false, finalized: true }
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    if (batch.length > 0) {
      await admin
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: 'Failed to decrypt access token' })
        .in('id', batch.map((r) => r.id))
    }
    await admin.from('broadcasts').update({ status: 'failed' }).eq('id', broadcast.id)
    return { sent: 0, failed: batch.length, hasMore: false, finalized: true }
  }

  // Nada pendente — finaliza se ainda não finalizou.
  if (batch.length === 0) {
    await finalizeIfDone(admin, broadcast.id)
    return { sent: 0, failed: 0, hasMore: false, finalized: true }
  }

  // ── Template row (1x) ──────────────────────────────────────────
  const { data: rawTemplate } = await admin
    .from('message_templates')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .eq('name', broadcast.template_name)
    .eq('language', language)
    .maybeSingle()
  const templateRow = rawTemplate && isMessageTemplate(rawTemplate) ? rawTemplate : null

  // ── Resolve variáveis por contato ──────────────────────────────
  const contactIds = batch
    .map((r) => (r.contact as unknown as { id?: string } | null)?.id)
    .filter((id): id is string => Boolean(id))
  const customValues = await fetchCustomValueIndex(admin, contactIds)
  const variables = broadcast.template_variables ?? {}

  // Recipients sem telefone falham direto; o resto vai pro envio.
  const sendable: { recipientId: string; input: BroadcastRecipientInput }[] = []
  const noPhoneIds: string[] = []
  for (const r of batch) {
    const contact = r.contact as unknown as
      | { id: string; phone?: string; name?: string; email?: string; company?: string }
      | null
    if (!contact?.phone) {
      noPhoneIds.push(r.id)
      continue
    }
    sendable.push({
      recipientId: r.id,
      input: {
        phone: contact.phone,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        params: resolveVariables(variables, contact as any, customValues.get(contact.id)),
      },
    })
  }

  let sent = 0
  let failed = noPhoneIds.length

  if (noPhoneIds.length > 0) {
    await admin
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'No phone number on contact' })
      .in('id', noPhoneIds)
  }

  // ── Envia o lote (lib compartilhada) ───────────────────────────
  if (sendable.length > 0) {
    const { results } = await sendRecipients({
      phoneNumberId: config.phone_number_id,
      accessToken,
      templateName: broadcast.template_name,
      language,
      templateRow,
      recipients: sendable.map((s) => s.input),
    })

    // results na mesma ordem do input → zip por índice.
    const nowIso = new Date().toISOString()
    for (let i = 0; i < sendable.length; i++) {
      const { recipientId } = sendable[i]
      const result = results[i]
      if (result?.status === 'sent') {
        sent++
        await admin
          .from('broadcast_recipients')
          .update({
            status: 'sent',
            sent_at: nowIso,
            whatsapp_message_id: result.whatsapp_message_id ?? null,
            error_message: null,
          })
          .eq('id', recipientId)
      } else {
        failed++
        await admin
          .from('broadcast_recipients')
          .update({ status: 'failed', error_message: result?.error ?? 'Unknown error' })
          .eq('id', recipientId)
      }
    }
  }

  // ── Sobrou pendente? Se não, finaliza a broadcast ──────────────
  const { count: remaining } = await admin
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')

  const hasMore = (remaining ?? 0) > 0
  let finalized = false
  if (!hasMore) {
    await finalizeIfDone(admin, broadcast.id)
    finalized = true
  }

  return { sent, failed, hasMore, finalized }
}

/**
 * Finaliza a broadcast: 'sent' se ao menos 1 recipient foi enviado, senão
 * 'failed'. Lê o sent_count mantido pelo trigger agregado.
 */
async function finalizeIfDone(admin: SupabaseClient, broadcastId: string): Promise<void> {
  const { data: b } = await admin
    .from('broadcasts')
    .select('sent_count')
    .eq('id', broadcastId)
    .maybeSingle()
  const finalStatus = (b?.sent_count ?? 0) > 0 ? 'sent' : 'failed'
  await admin.from('broadcasts').update({ status: finalStatus }).eq('id', broadcastId)
}
