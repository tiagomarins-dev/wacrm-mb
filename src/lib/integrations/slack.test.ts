import { describe, expect, it, vi, afterEach } from 'vitest'
import { postSlackMessage } from './slack'

afterEach(() => vi.unstubAllGlobals())

describe('postSlackMessage', () => {
  it('posta e devolve ts/channel', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ ok: true, ts: '1.2', channel: 'C1' }), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = await postSlackMessage({
      botToken: 't',
      channelId: 'C1',
      text: 'oi',
    })
    expect(out).toEqual({ ts: '1.2', channel: 'C1' })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.channel).toBe('C1')
    expect(body.text).toBe('oi')
  })

  it('ok:false (HTTP 200) → lança com o erro do Slack', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
          status: 200,
        }),
      ),
    )
    await expect(
      postSlackMessage({ botToken: 't', channelId: 'C1', text: 'oi' }),
    ).rejects.toThrow(/channel_not_found/)
  })
})
