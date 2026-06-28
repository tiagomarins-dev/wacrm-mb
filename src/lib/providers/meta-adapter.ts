// ============================================================
// Adapter Meta: implementa MessageProvider repassando ...args para as
// funções de meta-api.ts (phoneNumberId/accessToken fechados aqui).
// O wire é IDÊNTICO ao envio direto — provado pelos golden tests.
// ============================================================
import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  sendTypingIndicator,
  sendInteractiveButtons,
  sendInteractiveList,
} from '@/lib/whatsapp/meta-api'
import { CAPABILITIES, type MessageProvider } from './types'

// Recebe a credencial JÁ resolvida (token decriptado pelo sender).
export function createMetaAdapter(cred: {
  phoneNumberId: string
  accessToken: string
}): MessageProvider {
  const { phoneNumberId, accessToken } = cred
  return {
    id: 'meta',
    capabilities: CAPABILITIES.meta,
    sendText: (i) => sendTextMessage({ phoneNumberId, accessToken, ...i }),
    sendMedia: (i) => sendMediaMessage({ phoneNumberId, accessToken, ...i }),
    sendTemplate: (i) => sendTemplateMessage({ phoneNumberId, accessToken, ...i }),
    sendReaction: (i) => sendReactionMessage({ phoneNumberId, accessToken, ...i }),
    sendTyping: (i) =>
      sendTypingIndicator({ phoneNumberId, accessToken, messageId: i.messageId }),
    sendInteractiveButtons: (i) =>
      sendInteractiveButtons({ phoneNumberId, accessToken, ...i }),
    sendInteractiveList: (i) =>
      sendInteractiveList({ phoneNumberId, accessToken, ...i }),
  }
}
