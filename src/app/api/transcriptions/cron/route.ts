import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/broadcast/admin-client'
import { dispatchTranscription } from '@/lib/transcription/dispatch'
import { MAX_ATTEMPTS, MEDIA_MAX_WINDOW_H } from '@/lib/transcription/constants'

// Usa node:crypto (timingSafeEqual) + service-role; força runtime Node.
export const runtime = 'nodejs'

const LIMIT = 20

/**
 * Cron de retry da transcrição de áudio. Batido pelo sidecar (docker-compose)
 * com header `x-cron-secret` = AUTOMATION_CRON_SECRET (mesmo secret dos demais
 * crons). Reprocessa áudios pending/failed que ainda têm tentativas. O claim
 * atômico está dentro do dispatch, então não há corrida com o gatilho imediato.
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  // Comparação constant-time (mesmo padrão de broadcasts/cron) — length
  // pré-check exigido por timingSafeEqual e só vaza o tamanho.
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const a = Buffer.from(supplied)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  // Inbound (proxy) só dentro da janela Meta; outbound (http) é sempre recuperável.
  const cutoff = new Date(Date.now() - MEDIA_MAX_WINDOW_H * 3600_000).toISOString()
  // A conta NÃO está em `messages` (fica na conversa) — embeda conversations.
  const { data: due, error } = await admin
    .from('messages')
    .select('id, conversation_id, media_url, created_at, conversations!inner(account_id)')
    .eq('content_type', 'audio')
    .in('transcription_status', ['pending', 'failed'])
    .lt('transcription_attempts', MAX_ATTEMPTS)
    .order('created_at', { ascending: true })
    .limit(LIMIT)

  if (error) {
    console.error('[transcription] cron query falhou:', error.message)
    return NextResponse.json({ error: 'query failed' }, { status: 500 })
  }
  if (!due?.length) return NextResponse.json({ processed: 0 })

  let processed = 0
  for (const row of due) {
    const mediaUrl = row.media_url as string
    // Inbound fora da janela: a Meta já apagou a mídia — não adianta tentar.
    if (mediaUrl.startsWith('/api/whatsapp/media/') && (row.created_at as string) < cutoff) {
      await admin
        .from('messages')
        .update({ transcription_status: 'failed', transcription_attempts: MAX_ATTEMPTS })
        .eq('id', row.id)
      continue
    }
    // account_id vem do embed da conversa (relação to-one).
    const conv = row.conversations as unknown as { account_id: string }
    // O dispatch faz o claim atômico — sem corrida com o gatilho imediato.
    await dispatchTranscription({
      db: admin,
      messageId: row.id as string,
      accountId: conv.account_id,
      conversationId: row.conversation_id as string,
      mediaUrl,
    })
    processed++
  }
  return NextResponse.json({ processed })
}
