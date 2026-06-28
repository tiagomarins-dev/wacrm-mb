// ============================================================
// Factory que escolhe o adapter pelo provider da conexão. Recebe o
// token JÁ decriptado (o sender mantém decrypt + self-heal). 'meta' e
// ausente → MetaAdapter. 'evolution' → fase C (por ora lança).
// ============================================================
import type { WhatsAppConfig } from '@/types'
import { createMetaAdapter } from './meta-adapter'
import { ProviderCapabilityError, type MessageProvider } from './types'

// Constrói o MessageProvider da conexão. accessToken = token decriptado.
export function createMessageProvider(
  config: WhatsAppConfig,
  accessToken: string,
): MessageProvider {
  const provider = config.provider ?? 'meta'
  switch (provider) {
    case 'evolution':
      // Fase C: createEvolutionAdapter(...). Até lá, falha explícita.
      throw new ProviderCapabilityError(
        'Provider Evolution ainda não implementado (fase C).',
      )
    case 'meta':
    default:
      return createMetaAdapter({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
  }
}
