// ============================================================
// Contrato de envio agnóstico de provedor. Os args espelham meta-api.ts
// menos phoneNumberId/accessToken (fechados no adapter). Capabilities
// declaram o que cada provedor suporta (broadcast em massa = meta-only;
// grupos = evolution, fase E).
// ============================================================
import type {
  MetaSendResult,
  SendTextMessageArgs,
  SendMediaMessageArgs,
  SendTemplateMessageArgs,
  SendReactionMessageArgs,
  SendInteractiveButtonsArgs,
  SendInteractiveListArgs,
} from '@/lib/whatsapp/meta-api'

export type ProviderId = 'meta' | 'evolution'

export interface ProviderCapabilities {
  text: boolean
  media: boolean
  template: boolean
  interactive: boolean
  reaction: boolean
  typing: boolean
  groups: boolean
  massBroadcast: boolean
}

// Os inputs reusam os args de meta-api.ts SEM as credenciais (1:1, sem drift).
type Cred = 'phoneNumberId' | 'accessToken'
export type SendTextInput = Omit<SendTextMessageArgs, Cred>
export type SendMediaInput = Omit<SendMediaMessageArgs, Cred>
export type SendTemplateInput = Omit<SendTemplateMessageArgs, Cred>
export type SendReactionInput = Omit<SendReactionMessageArgs, Cred>
export type SendButtonsInput = Omit<SendInteractiveButtonsArgs, Cred>
export type SendListInput = Omit<SendInteractiveListArgs, Cred>

export interface MessageProvider {
  readonly id: ProviderId
  readonly capabilities: ProviderCapabilities
  sendText(i: SendTextInput): Promise<MetaSendResult>
  sendMedia(i: SendMediaInput): Promise<MetaSendResult>
  sendTemplate(i: SendTemplateInput): Promise<MetaSendResult>
  sendReaction(i: SendReactionInput): Promise<MetaSendResult>
  sendTyping(i: { messageId: string }): Promise<void>
  sendInteractiveButtons(i: SendButtonsInput): Promise<MetaSendResult>
  sendInteractiveList(i: SendListInput): Promise<MetaSendResult>
}

// Erro p/ capability não suportada (Evolution lança em template/reaction etc., fase C).
export class ProviderCapabilityError extends Error {}

// Capabilities por provider — pura, consultável sem instanciar adapter
// (ex.: guard de broadcast em massa). Evolution já declarado p/ a fase C.
export const CAPABILITIES: Record<ProviderId, ProviderCapabilities> = {
  meta: {
    text: true, media: true, template: true, interactive: true,
    reaction: true, typing: true, groups: false, massBroadcast: true,
  },
  evolution: {
    text: true, media: true, template: false, interactive: false,
    reaction: false, typing: false, groups: true, massBroadcast: false,
  },
}

// Devolve as capabilities do provider (default 'meta' p/ ausente/legado).
export function capabilitiesFor(
  id: ProviderId | undefined | null,
): ProviderCapabilities {
  return CAPABILITIES[id ?? 'meta'] ?? CAPABILITIES.meta
}
