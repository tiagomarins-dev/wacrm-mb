// ============================================================
// Factory que escolhe o adapter pelo provider da conexão. Recebe o
// token JÁ decriptado (o sender mantém decrypt + self-heal). 'meta' e
// ausente → MetaAdapter. 'evolution' → fase C (por ora lança).
// ============================================================
import type { WhatsAppConfig } from '@/types'
import { createMetaAdapter } from './meta-adapter'
import { createEvolutionAdapter } from './evolution-adapter'
import { ProviderCapabilityError, type MessageProvider } from './types'

// Constrói o MessageProvider da conexão. accessToken = token decriptado.
// V2: despacha por provider ANTES de usar o token — o Evolution usa a
// chave GLOBAL do env (EVOLUTION_API_KEY), nunca o access_token.
export function createMessageProvider(
  config: WhatsAppConfig,
  accessToken: string,
): MessageProvider {
  const provider = config.provider ?? 'meta'
  switch (provider) {
    case 'evolution': {
      // Base URL por-conexão (opcional) ou a global do env. apiKey é global.
      const baseUrl = config.evolution_base_url ?? process.env.EVOLUTION_API_URL
      const apiKey = process.env.EVOLUTION_API_KEY
      if (!baseUrl || !apiKey || !config.instance_name) {
        throw new ProviderCapabilityError(
          'Conexão Evolution incompleta (EVOLUTION_API_URL/KEY ou instance_name ausente).',
        )
      }
      return createEvolutionAdapter({ baseUrl, apiKey, instance: config.instance_name })
    }
    case 'meta':
    default:
      return createMetaAdapter({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
  }
}
