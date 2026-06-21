import { describe, expect, it, vi, afterEach } from 'vitest'
import { createNotionPage } from './notion'

afterEach(() => vi.unstubAllGlobals())

describe('createNotionPage', () => {
  it('detecta a prop title, monta a página e devolve a URL', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'GET') {
        // GET database → schema com prop title chamada "Tarefa"
        return new Response(
          JSON.stringify({ properties: { Tarefa: { type: 'title' }, Status: { type: 'select' } } }),
          { status: 200 },
        )
      }
      // POST page
      return new Response(JSON.stringify({ url: 'https://notion.so/abc' }), {
        status: 200,
      })
    })
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

    const out = await createNotionPage({
      apiKey: 'k',
      databaseId: 'db1',
      title: 'Bug - Tiago',
      body: 'Linha 1\nLinha 2',
    })
    expect(out.url).toBe('https://notion.so/abc')

    const postBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(postBody.parent.database_id).toBe('db1')
    expect(postBody.properties.Tarefa.title[0].text.content).toBe('Bug - Tiago')
    expect(postBody.children).toHaveLength(2)
  })

  it('erro do Notion → lança', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        init.method === 'GET'
          ? new Response(JSON.stringify({ properties: { Name: { type: 'title' } } }), { status: 200 })
          : new Response(JSON.stringify({ message: 'invalid' }), { status: 400 }),
      ) as unknown as typeof fetch,
    )
    await expect(
      createNotionPage({ apiKey: 'k', databaseId: 'db1', title: 't', body: 'b' }),
    ).rejects.toThrow(/Notion error 400/)
  })
})
