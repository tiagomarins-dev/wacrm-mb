// ============================================================
// Normaliza um record da Evolution (/chat/findMessages) p/ o modelo
// interno de mensagem. Mapeia messageType → content_type, extrai
// texto/legenda e o telefone do remoteJid. Grupo (@g.us) e tipos não
// suportados retornam null (fase E trata grupo). Puro/testável.
// ============================================================
import type { EvoRecord } from './evolution-api'

export type EvoContentType = 'text' | 'image' | 'audio' | 'video' | 'document'

export interface NormalizedInbound {
  messageId: string
  phone: string
  name: string
  fromMe: boolean
  contentType: EvoContentType
  contentText: string | null
  hasMedia: boolean
  timestamp: number
}

// messageType da Evolution → content_type interno.
const TYPE_MAP: Record<string, EvoContentType> = {
  conversation: 'text',
  extendedTextMessage: 'text',
  imageMessage: 'image',
  audioMessage: 'audio',
  videoMessage: 'video',
  documentMessage: 'document',
}

// Devolve a mensagem normalizada, ou null se for grupo / tipo não suportado /
// sem id. fromMe NÃO é filtrado aqui (o chamador descarta os próprios ecos).
export function normalizeEvolutionInbound(rec: EvoRecord): NormalizedInbound | null {
  const rawJid = rec.key?.remoteJid ?? ''
  // @lid (linked identity): o telefone real vem em remoteJidAlt. Resolve p/
  // o JID de telefone; sem ele, não dá p/ identificar o contato → null.
  const jid = rawJid.endsWith('@lid') ? (rec.key?.remoteJidAlt ?? '') : rawJid
  // Grupo é fase E; sem jid (ou @lid sem alt) não dá p/ resolver o contato.
  if (!jid || jid.endsWith('@g.us')) return null
  const messageId = rec.key?.id ?? ''
  if (!messageId) return null

  const contentType = TYPE_MAP[rec.messageType ?? '']
  if (!contentType) return null // tipo não suportado (location, reaction, etc.)

  const phone = jid.split('@')[0]
  const m = rec.message ?? {}
  const contentText =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null

  return {
    messageId,
    phone,
    name: rec.pushName || phone,
    fromMe: Boolean(rec.key?.fromMe),
    contentType,
    contentText,
    hasMedia: contentType !== 'text',
    timestamp: Number(rec.messageTimestamp) || 0,
  }
}
