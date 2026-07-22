import { randomBytes } from 'node:crypto'

// Token público do blueprint de broadcast: 'bh_' + 128 bits em hex.
// Prefixo próprio (vs wh_ das automações) distingue o domínio em logs.
// Texto plano em broadcasts.webhook_token (mig 075) de propósito: a UI
// re-exibe a URL; mitigação = escopo mínimo, rate limit, regenerate.
export function generateBroadcastWebhookToken(): string {
  return 'bh_' + randomBytes(16).toString('hex')
}
