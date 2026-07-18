import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  firstSendStepType,
  type StepLike,
  type ValidationIssue,
} from './validate'

// Gera o token público do trigger webhook: 'wh_' + 128 bits em hex.
// Armazenado em TEXTO PLANO em automations.webhook_token (mig 074) —
// diferente do padrão hash das invitations (peek/route.ts) de
// propósito: o builder precisa re-exibir a URL completa a qualquer
// momento. Mitigação: escopo mínimo (dispara 1 automação), 404
// genérico, rate limit por IP e regeneração fácil.
export function generateWebhookToken(): string {
  return 'wh_' + randomBytes(16).toString('hex')
}

// Valida a regra "template primeiro" pra automação webhook em conexão
// Meta oficial: contato acionado por webhook está fora da janela de 24h,
// então o primeiro nó de envio precisa ser send_template. Retorna issue
// no mesmo shape do validate.ts (o builder mostra issues[0] em toast).
export async function validateWebhookMetaTemplateFirst(
  admin: SupabaseClient,
  connectionId: string,
  steps: StepLike[],
): Promise<ValidationIssue[]> {
  const { data: conn } = await admin
    .from('whatsapp_config')
    .select('provider')
    .eq('id', connectionId)
    .maybeSingle()
  // provider ausente = meta (padrão da mig 056 / factory.ts)
  const isMeta = ((conn?.provider as string | null) ?? 'meta') === 'meta'
  if (isMeta && firstSendStepType(steps) === 'send_message') {
    return [
      {
        path: 'steps',
        message:
          'Automação webhook em conexão Meta oficial precisa iniciar o envio com um template aprovado (janela de 24h). Troque o primeiro nó de mensagem por "Enviar modelo".',
      },
    ]
  }
  return []
}
