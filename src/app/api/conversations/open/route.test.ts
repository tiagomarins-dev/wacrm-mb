// ============================================================
// Testa POST /api/conversations/open por invocação direta do handler
// (sem HTTP). Mocka supabase server + resolveOutboundConfig + findOrCreate.
// Cobre: 200 happy, 401/403/400/404, 400 sem conexão, idempotência,
// fallback de conexão nula → primária, e o guard de phone.
//
// Segundo bloco: o branch `phone` do deep-link externo. Os testes do branch
// `contact_id` ficam como REGRESSÃO — o guard de papel do branch novo não pode
// vazar pra cima e mudar o contrato de quem já usava a rota.
// ============================================================
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

// Estado compartilhado p/ o mock do supabase (hoisted p/ o vi.mock ler).
const h = vi.hoisted(() => ({
  user: { id: 'u1' } as { id: string } | null,
  account: 'a1' as string | null,
  contact: { id: 'c1', phone: '+5511999' } as
    | { id: string; phone: string | null }
    | null,
}))

// Builder mínimo: resolve por tabela no maybeSingle (igual evolution/connect).
vi.mock('@/lib/supabase/server', () => {
  function from(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      maybeSingle: () => {
        if (table === 'profiles')
          return Promise.resolve({
            data: h.account ? { account_id: h.account } : null,
          })
        if (table === 'contacts') return Promise.resolve({ data: h.contact })
        return Promise.resolve({ data: null })
      },
    }
    return b
  }
  return {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
      from,
    }),
  }
})

// Config resolvida + conversa criada mockadas (a rota só orquestra).
const resolveMock = vi.fn(async (..._a: unknown[]) => ({
  id: 'conn1',
  user_id: 'owner1',
  account_id: 'a1',
}))
vi.mock('@/lib/connections/resolve', () => ({
  resolveOutboundConfig: (...a: unknown[]) => resolveMock(...a),
}))
const findMock = vi.fn(async (..._a: unknown[]) => ({ id: 'conv1' }))
vi.mock('@/lib/whatsapp/inbound', () => ({
  findOrCreateConversation: (...a: unknown[]) => findMock(...a),
}))

// --- branch `phone` (deep-link da Plataforma MB) -------------------------
// requireRole é o guard de papel do projeto; aqui ele só reflete o papel do
// estado hoisted, e lança o mesmo ForbiddenError que a implementação real.
const hp = vi.hoisted(() => ({
  role: 'agent' as 'owner' | 'admin' | 'agent' | 'viewer',
  suporte: { id: 'conn-suporte', user_id: 'owner1', account_id: 'a1' } as
    | { id: string; user_id: string; account_id: string }
    | null,
  supportFailure: null as string | null,
}))

vi.mock('@/lib/auth/account', async () => {
  class ForbiddenError extends Error {
    status = 403
  }
  class UnauthorizedError extends Error {
    status = 401
  }
  const rank = { viewer: 1, agent: 2, admin: 3, owner: 4 } as Record<string, number>
  return {
    ForbiddenError,
    UnauthorizedError,
    requireRole: async (min: string) => {
      if (!h.user) throw new UnauthorizedError('Unauthorized')
      if (!h.account) throw new ForbiddenError('Profile is not linked to an account')
      if (rank[hp.role] < rank[min]) {
        throw new ForbiddenError(`This action requires the '${min}' role or higher`)
      }
      return {
        supabase: {},
        userId: h.user.id,
        accountId: h.account,
        role: hp.role,
        account: { id: h.account, name: 'A' },
      }
    },
    toErrorResponse: (err: unknown) => {
      const status = (err as { status?: number })?.status
      if (status === 401 || status === 403) {
        return NextResponse.json({ error: (err as Error).message }, { status })
      }
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    },
  }
})

vi.mock('@/lib/connections/support', () => {
  class SupportConnectionError extends Error {
    constructor(readonly reason: string) {
      super(reason)
    }
  }
  return {
    SupportConnectionError,
    resolveSupportConfig: async () => {
      if (hp.supportFailure) throw new SupportConnectionError(hp.supportFailure)
      return hp.suporte
    },
  }
})

// Normalização e sanitização entram REAIS — são contrato com o lado PHP e
// precisam ser exercitadas de ponta a ponta pela rota. Só a escrita é mockada.
const contatoMock = vi.fn(async (..._a: unknown[]) => ({
  contact: { id: 'c-novo' },
  wasCreated: true,
}))
vi.mock('@/lib/conversations/open-by-phone', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/conversations/open-by-phone')>()
  return {
    ...real,
    findOrCreateContactByPhone: (...a: unknown[]) => contatoMock(...a),
  }
})

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://localhost/api/conversations/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  h.user = { id: 'u1' }
  h.account = 'a1'
  h.contact = { id: 'c1', phone: '+5511999' }
  resolveMock.mockResolvedValue({ id: 'conn1', user_id: 'owner1', account_id: 'a1' })
  findMock.mockResolvedValue({ id: 'conv1' })
  hp.role = 'agent'
  hp.suporte = { id: 'conn-suporte', user_id: 'owner1', account_id: 'a1' }
  hp.supportFailure = null
  contatoMock.mockResolvedValue({ contact: { id: 'c-novo' }, wasCreated: true })
  __resetRateLimitForTests()
})

describe('POST /api/conversations/open', () => {
  it('200 + conversation_id no happy path', async () => {
    const res = await POST(req({ contact_id: 'c1', connection_id: 'conn1' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ conversation_id: 'conv1' })
  })

  it('401 sem user', async () => {
    h.user = null
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(401)
  })

  it('403 sem account', async () => {
    h.account = null
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(403)
  })

  it('400 sem contact_id', async () => {
    expect((await POST(req({}))).status).toBe(400)
  })

  it('404 contato de outra conta (não achado)', async () => {
    h.contact = null
    expect((await POST(req({ contact_id: 'cX' }))).status).toBe(404)
  })

  it('400 contato sem phone', async () => {
    h.contact = { id: 'c1', phone: null }
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(400)
  })

  it('400 conta sem conexão (resolve throw)', async () => {
    resolveMock.mockRejectedValueOnce(new Error('no conn'))
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(400)
  })

  it('idempotente: mesma conversa nas 2 chamadas', async () => {
    const a = await (await POST(req({ contact_id: 'c1' }))).json()
    const b = await (await POST(req({ contact_id: 'c1' }))).json()
    expect(a.conversation_id).toBe(b.conversation_id)
  })

  it('fallback: connection_id nulo → resolve chamado com null (primária)', async () => {
    await POST(req({ contact_id: 'c1' }))
    expect(resolveMock).toHaveBeenCalledWith(expect.anything(), 'a1', null)
  })
})

describe('POST /api/conversations/open — branch phone (deep-link externo)', () => {
  it('200 e cria o contato quando o número é novo', async () => {
    const res = await POST(req({ phone: '5521999998888', nome: 'Ana' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      conversation_id: 'conv1',
      contact_id: 'c-novo',
      created_contact: true,
    })
  })

  it('200 e reusa quando o contato já existe', async () => {
    contatoMock.mockResolvedValueOnce({ contact: { id: 'c1' }, wasCreated: false })
    const res = await POST(req({ phone: '5521999998888' }))
    expect(await res.json()).toMatchObject({ contact_id: 'c1', created_contact: false })
  })

  it('sempre abre na conexão de Suporte, nunca na primária', async () => {
    // O aluno que só existe no Comercial ganha contato NOVO no Suporte — é a
    // decisão de produto "sempre Suporte", virando asserção.
    await POST(req({ phone: '5521999998888' }))
    expect(contatoMock).toHaveBeenCalledWith(
      expect.anything(), 'a1', 'owner1', 'conn-suporte', '5521999998888', '5521999998888',
    )
    expect(findMock).toHaveBeenCalledWith(
      expect.anything(), 'a1', 'owner1', 'conn-suporte', 'c-novo',
    )
    // resolveOutboundConfig é o que faria o fallback silencioso — não pode rodar.
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it('ignora connection_id do body', async () => {
    await POST(req({ phone: '5521999998888', connection_id: 'conn-comercial' }))
    expect(contatoMock).toHaveBeenCalledWith(
      expect.anything(), 'a1', 'owner1', 'conn-suporte', expect.anything(), expect.anything(),
    )
  })

  it('normaliza telefone com máscara e sem DDI', async () => {
    await POST(req({ phone: '(21) 99999-8888' }))
    expect(contatoMock).toHaveBeenCalledWith(
      expect.anything(), 'a1', 'owner1', 'conn-suporte', '5521999998888', expect.anything(),
    )
  })

  it('sanitiza o nome e cai no telefone quando vazio', async () => {
    await POST(req({ phone: '5521999998888', nome: '  ' }))
    expect(contatoMock).toHaveBeenCalledWith(
      expect.anything(), 'a1', 'owner1', 'conn-suporte', '5521999998888', '5521999998888',
    )
  })

  it('trunca nome gigante em 80 caracteres', async () => {
    await POST(req({ phone: '5521999998888', nome: 'a'.repeat(300) }))
    const nomeUsado = contatoMock.mock.calls[0][5] as string
    expect(nomeUsado).toHaveLength(80)
  })

  it.each([['abc'], [''], ['999998888'], ['1234567890123456']])(
    '422 para telefone inválido: %s',
    async (tel) => {
      const res = await POST(req({ phone: tel }))
      expect(res.status).toBe(422)
      expect((await res.json()).code).toBe('invalid_phone')
    },
  )

  it('409 quando a conexão de Suporte não resolve, sem vazar o id', async () => {
    for (const motivo of ['unconfigured', 'not_in_account', 'archived']) {
      hp.supportFailure = motivo
      const res = await POST(req({ phone: '5521999998888' }))
      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.code).toBe('support_connection_unavailable')
      expect(JSON.stringify(body)).not.toContain('conn-suporte')
      __resetRateLimitForTests()
    }
  })

  it('403 para viewer', async () => {
    hp.role = 'viewer'
    expect((await POST(req({ phone: '5521999998888' }))).status).toBe(403)
  })

  it('401 sem sessão', async () => {
    h.user = null
    expect((await POST(req({ phone: '5521999998888' }))).status).toBe(401)
  })

  it('429 no bucket próprio, SEM consumir a cota de envio', async () => {
    for (let i = 0; i < 20; i++) {
      expect((await POST(req({ phone: '5521999998888' }))).status).toBe(200)
    }
    expect((await POST(req({ phone: '5521999998888' }))).status).toBe(429)
    // O caminho por contact_id (bucket `send`) continua liberado.
    expect((await POST(req({ contact_id: 'c1' }))).status).toBe(200)
  })

  it('contact_id tem precedência quando os dois vêm', async () => {
    const res = await POST(req({ contact_id: 'c1', phone: '5521999998888' }))
    expect(await res.json()).toEqual({ conversation_id: 'conv1' })
    expect(contatoMock).not.toHaveBeenCalled()
  })

  it('500 com code quando a criação do contato falha', async () => {
    contatoMock.mockResolvedValueOnce(null as never)
    const res = await POST(req({ phone: '5521999998888' }))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe('contact_create_failed')
  })
})

describe('POST /api/conversations/open — corpo malformado', () => {
  it('400 (não 500) quando o body não é JSON', async () => {
    const bad = new Request('http://localhost/api/conversations/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'nao-e-json',
    })
    expect((await POST(bad)).status).toBe(400)
  })
})
