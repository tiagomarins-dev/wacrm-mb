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
  // Grupo (058): isGroup + chatId (JID @g.us). Em grupo o remetente vem em
  // senderName (pushName) / senderPhone (participantAlt); phone fica vazio.
  isGroup: boolean
  chatId: string | null
  senderName: string | null
  senderPhone: string | null
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

// Deriva o tipo (chave do TYPE_MAP) a partir das chaves do objeto message.
// Usado p/ conteúdo desembrulhado (ephemeralMessage) onde o messageType do
// record é só o wrapper. Retorna a 1ª chave conhecida, ou '' se nenhuma.
function deriveTypeFromMessage(m: Record<string, unknown>): string {
  for (const k of Object.keys(TYPE_MAP)) {
    if (m[k] != null) return k
  }
  return ''
}

// Devolve a mensagem normalizada, ou null se for grupo / tipo não suportado /
// sem id. fromMe NÃO é filtrado aqui (o chamador descarta os próprios ecos).
export function normalizeEvolutionInbound(rec: EvoRecord): NormalizedInbound | null {
  const rawJid = rec.key?.remoteJid ?? ''
  // Grupo (058): remoteJid termina em @g.us → chat_id do grupo. 1:1: @lid
  // (linked identity) resolve o telefone real via remoteJidAlt; senão é o
  // próprio @s.whatsapp.net.
  const isGroup = rawJid.endsWith('@g.us')
  const jid = isGroup
    ? rawJid
    : rawJid.endsWith('@lid')
      ? (rec.key?.remoteJidAlt ?? '')
      : rawJid
  // Sem jid (ou @lid sem alt) não dá p/ resolver o destino → null.
  if (!jid) return null
  const messageId = rec.key?.id ?? ''
  if (!messageId) return null

  // Desembrulha ephemeralMessage (msgs temporárias): o conteúdo real fica
  // aninhado em message.ephemeralMessage.message; o messageType do record é só
  // o wrapper. Deriva o tipo das chaves do conteúdo interno.
  let m = rec.message ?? {}
  let messageType = rec.messageType ?? ''
  const ephemeral = m.ephemeralMessage?.message
  if (ephemeral) {
    m = ephemeral
    messageType = deriveTypeFromMessage(m)
  }

  const contentType = TYPE_MAP[messageType]
  if (!contentType) return null // tipo não suportado (location, reaction, etc.)

  const contentText =
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    null

  // Em grupo o remetente vem em key.participant(@lid)/participantAlt(telefone);
  // pushName é o nome de quem mandou. Em 1:1, phone = jid (telefone).
  const senderPhone = isGroup
    ? (rec.key?.participantAlt?.split('@')[0] ?? null)
    : null
  const phone = isGroup ? '' : jid.split('@')[0]

  return {
    messageId,
    phone,
    name: rec.pushName || phone,
    fromMe: Boolean(rec.key?.fromMe),
    contentType,
    contentText,
    hasMedia: contentType !== 'text',
    timestamp: Number(rec.messageTimestamp) || 0,
    isGroup,
    chatId: isGroup ? rawJid : null,
    senderName: isGroup ? (rec.pushName || senderPhone || 'Participante') : null,
    senderPhone,
  }
}
