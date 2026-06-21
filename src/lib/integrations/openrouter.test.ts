import { describe, expect, it, vi, afterEach } from 'vitest'
import {
  serializeMessages,
  summarizeConversation,
  type SummaryMessage,
} from './openrouter'

const msgs: SummaryMessage[] = [
  { sender_type: 'customer', content_text: 'A plataforma está com erro' },
  { sender_type: 'agent', content_text: 'Pode detalhar o erro?' },
  { sender_type: 'customer', content_type: 'image', content_text: null },
]

describe('serializeMessages', () => {
  it('rotula por papel e troca não-texto por placeholder', () => {
    expect(serializeMessages(msgs)).toBe(
      'Cliente: A plataforma está com erro\n' +
        'Atendente: Pode detalhar o erro?\n' +
        'Cliente: [imagem]',
    )
  })

  it('pega só as últimas N', () => {
    const many: SummaryMessage[] = Array.from({ length: 40 }, (_, i) => ({
      sender_type: 'customer',
      content_text: `m${i}`,
    }))
    const out = serializeMessages(many, 5)
    expect(out.split('\n')).toHaveLength(5)
    expect(out).toContain('m39')
    expect(out).not.toContain('m34')
  })
})

describe('summarizeConversation', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('monta payload sem PII (só 1º nome) + no-logging, e devolve o resumo', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Resumo X' } }] }),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await summarizeConversation({
      apiKey: 'k',
      model: 'm',
      messages: msgs,
      topic: 'Bug',
      firstName: 'Tiago',
    })
    expect(out).toBe('Resumo X')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.provider).toEqual({ data_collection: 'deny' })
    const userMsg = body.messages[1].content as string
    expect(userMsg).toContain('Assunto: Bug')
    expect(userMsg).toContain('Tiago')
    // sem PII além do 1º nome
    expect(userMsg).not.toContain('@')
    expect(userMsg).not.toMatch(/\d{8,}/)
  })

  it('erro de API → lança', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'nope' } }), {
          status: 401,
        }),
      ),
    )
    await expect(
      summarizeConversation({ apiKey: 'k', messages: msgs, topic: 'X' }),
    ).rejects.toThrow(/OpenRouter error 401/)
  })
})
