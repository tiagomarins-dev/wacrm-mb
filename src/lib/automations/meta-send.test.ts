// ============================================================
// engineSendTemplate pelo wire real da Meta (MSW). Prova que o sufixo de
// botão de URL chega como componente `button` sub_type=url — só possível
// quando a linha do template é carregada da conexão que envia — e que,
// sem buttonParams, o envio continua só-corpo como antes.
// ============================================================
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { server } from '@/test/msw/server'
import { captureMetaSend, type CapturedRequest } from '@/test/msw/handlers/meta'
import { encrypt } from '@/lib/whatsapp/encryption'

const store = vi.hoisted(() => ({
  template: null as Record<string, unknown> | null,
  templateFilters: [] as [string, unknown][],
}))

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === 'contacts') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: () => b,
          maybeSingle: async () => ({ data: { id: 'c1', phone: '5521999990000' }, error: null }),
          update: () => ({ eq: async () => ({ error: null }) }),
        }
        return b
      }
      if (table === 'message_templates') {
        const b: Record<string, unknown> = {
          select: () => b,
          eq: (col: string, val: unknown) => {
            store.templateFilters.push([col, val])
            return b
          },
          maybeSingle: async () => ({ data: store.template, error: null }),
        }
        return b
      }
      if (table === 'messages') return { insert: async () => ({ error: null }) }
      if (table === 'conversations') {
        return { update: () => ({ eq: async () => ({ error: null }) }) }
      }
      throw new Error(`unexpected table: ${table}`)
    },
  }),
}))

vi.mock('@/lib/connections/resolve', () => ({
  resolveOutboundConfigForConversation: vi.fn(async () => ({
    id: 'conn-1134',
    provider: 'meta',
    phone_number_id: '1555000111',
    access_token: encrypt('tok-TESTE'),
  })),
}))

import { engineSendTemplate } from './meta-send'

const BASE = {
  accountId: 'acct-1',
  userId: 'u1',
  conversationId: 'conv1',
  contactId: 'c1',
  templateName: 'mb_acesso_conta_link',
  language: 'pt_BR',
}

function templateComBotao() {
  return {
    id: 't1',
    user_id: 'u1',
    name: 'mb_acesso_conta_link',
    language: 'pt_BR',
    body_text: 'Olá, {{1}}. Seu link de acesso está pronto.',
    buttons: [
      {
        type: 'URL',
        text: 'Acessar minha conta',
        url: 'https://plataforma.millaborges.com/definir-senha?t={{1}}',
      },
    ],
  }
}

async function enviar(args: Parameters<typeof engineSendTemplate>[0]) {
  const sink: { req?: CapturedRequest } = {}
  server.use(captureMetaSend(sink))
  await engineSendTemplate(args)
  if (!sink.req) throw new Error('nenhuma request capturada')
  return JSON.parse(sink.req.rawBody) as { template: { components?: unknown[] } }
}

beforeEach(() => {
  store.template = null
  store.templateFilters = []
})

describe('engineSendTemplate — botão de URL', () => {
  it('manda o sufixo como componente button sub_type=url no índice certo', async () => {
    store.template = templateComBotao()
    const body = await enviar({ ...BASE, params: ['Maria'], buttonParams: { 0: 'tok123' } })

    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Maria' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'tok123' }] },
    ])
    // linha buscada na conexão que envia, por nome e idioma
    expect(store.templateFilters).toEqual(
      expect.arrayContaining([
        ['account_id', 'acct-1'],
        ['connection_id', 'conn-1134'],
        ['name', 'mb_acesso_conta_link'],
        ['language', 'pt_BR'],
      ]),
    )
  })

  it('sem buttonParams não consulta o template e envia só o corpo', async () => {
    const body = await enviar({ ...BASE, params: ['Maria'] })

    expect(store.templateFilters).toEqual([])
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Maria' }] },
    ])
  })

  it('falha com mensagem clara quando o template não existe na conexão', async () => {
    store.template = null
    await expect(
      engineSendTemplate({ ...BASE, params: ['Maria'], buttonParams: { 0: 'tok123' } }),
    ).rejects.toThrow('template mb_acesso_conta_link (pt_BR) not found on this connection')
  })
})
