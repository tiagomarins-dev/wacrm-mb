// ============================================================
// Adapter Evolution (fase C): implementa MessageProvider. Só sendText
// é suportado nesta fase (texto livre 1:1 — sem template, sem janela
// de 24h); media/template/reaction/interactive/typing lançam
// ProviderCapabilityError (chegam nas fases D/E). Usa a chave GLOBAL
// do env (nunca o access_token da conexão).
// ============================================================
import { evoSendText } from './evolution-api'
import { CAPABILITIES, ProviderCapabilityError, type MessageProvider } from './types'

export function createEvolutionAdapter(a: {
  baseUrl: string
  apiKey: string
  instance: string
}): MessageProvider {
  // Operação ainda não suportada no Evolution nesta fase.
  const naoSuportado = (op: string): never => {
    throw new ProviderCapabilityError(`Evolution não suporta ${op} (fase C).`)
  }
  return {
    id: 'evolution',
    capabilities: CAPABILITIES.evolution,
    // Texto livre 1:1 — number = telefone só-dígitos.
    sendText: (i) =>
      evoSendText({
        baseUrl: a.baseUrl,
        apiKey: a.apiKey,
        instance: a.instance,
        number: i.to,
        text: i.text,
      }),
    // async → o throw vira Promise rejeitada (não estoura síncrono no caller).
    sendMedia: async () => naoSuportado('mídia'), // fase D/E
    sendTemplate: async () => naoSuportado('templates'), // meta-only
    sendReaction: async () => naoSuportado('reações'),
    sendTyping: async () => {}, // no-op cosmético
    sendInteractiveButtons: async () => naoSuportado('botões'),
    sendInteractiveList: async () => naoSuportado('listas'),
  }
}
