// ============================================================
// Primeiro teste do middleware. Ele é caminho de auth de TODA requisição do app
// (o matcher pega tudo menos assets), então além do `?next=` novo estes casos
// travam o comportamento que já existia: precedência do convite, allowlist
// ancorada do webhook e o 401 das rotas de API do WhatsApp.
// ============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
}))

// createServerClient é o único ponto de I/O do middleware: devolve um cliente
// cujo getUser é controlado pelo estado hoisted. O `cookies.getAll/setAll` é
// exercitado pelo middleware na construção, então precisa existir.
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: h.user } }) },
  }),
}))

import { middleware } from './middleware'

/** Location do redirect, ou null quando a resposta segue adiante. */
function loc(res: Response): string | null {
  return res.headers.get('location')
}

function req(url: string): NextRequest {
  return new NextRequest(new URL(url, 'https://app.test'))
}

beforeEach(() => {
  h.user = null
})

describe('rota protegida sem sessão', () => {
  it('manda pro /login guardando o destino em ?next=', async () => {
    const res = await middleware(req('/inbox'))
    expect(loc(res)).toBe('https://app.test/login?next=%2Finbox')
  })

  it('preserva a query do deep-link dentro do next, e NÃO solta na URL do login', async () => {
    const res = await middleware(req('/inbox/abrir?tel=5521999998888&nome=Ana'))
    const destino = loc(res) as string

    expect(destino).toBe(
      'https://app.test/login?next=%2Finbox%2Fabrir%3Ftel%3D5521999998888%26nome%3DAna',
    )
    // O telefone só pode existir dentro do next, nunca como parâmetro solto.
    const params = new URL(destino).searchParams
    expect(params.get('tel')).toBeNull()
    expect(params.get('nome')).toBeNull()
    expect(params.get('next')).toBe('/inbox/abrir?tel=5521999998888&nome=Ana')
  })

  it('não escreve next quando o destino é o próprio /dashboard', async () => {
    const res = await middleware(req('/dashboard'))
    expect(loc(res)).toBe('https://app.test/login')
  })

  it('deixa passar rota pública', async () => {
    const res = await middleware(req('/login'))
    expect(loc(res)).toBeNull()
  })
})

describe('página de auth com sessão', () => {
  beforeEach(() => {
    h.user = { id: 'u1' }
  })

  it('segue o next válido', async () => {
    const res = await middleware(
      req('/login?next=%2Finbox%2Fabrir%3Ftel%3D5521999998888'),
    )
    expect(loc(res)).toBe('https://app.test/inbox/abrir?tel=5521999998888')
  })

  it('ignora next forjado e cai no /dashboard', async () => {
    for (const forjado of ['//evil.com', 'https://evil.com', '/\\evil.com', '/login']) {
      const res = await middleware(
        req(`/login?next=${encodeURIComponent(forjado)}`),
      )
      expect(loc(res)).toBe('https://app.test/dashboard')
    }
  })

  it('convite tem precedência sobre o next', async () => {
    const res = await middleware(req('/login?invite=tok123&next=%2Finbox'))
    expect(loc(res)).toBe('https://app.test/join/tok123')
  })

  it('sem next vai pro /dashboard, como antes', async () => {
    const res = await middleware(req('/login'))
    expect(loc(res)).toBe('https://app.test/dashboard')
  })
})

describe('regressão: allowlist das rotas de API do WhatsApp', () => {
  it('bloqueia rota de API sem sessão', async () => {
    const res = await middleware(req('/api/whatsapp/messages'))
    expect(res.status).toBe(401)
  })

  it('deixa o webhook passar (valida assinatura Meta por conta própria)', async () => {
    const res = await middleware(req('/api/whatsapp/webhook'))
    expect(res.status).not.toBe(401)
  })

  it('deixa o cron da Evolution passar (valida x-cron-secret)', async () => {
    const res = await middleware(req('/api/whatsapp/evolution/cron'))
    expect(res.status).not.toBe(401)
  })

  it('a allowlist é ancorada: cron-qualquer NÃO fura a auth', async () => {
    const res = await middleware(req('/api/whatsapp/evolution/cron-qualquer'))
    expect(res.status).toBe(401)
  })
})
