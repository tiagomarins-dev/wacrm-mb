import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { parseSafeNext } from '@/lib/auth/safe-next'

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
      return NextResponse.redirect(url)
    }
    // Destino guardado quando a sessão ainda não existia (ex: chegou pelo link
    // externo da Plataforma MB e logou em outra aba). `new URL` em vez de trocar
    // o pathname porque o destino carrega query própria — e só é seguro DEPOIS
    // do parseSafeNext, que é quem barra `//`, `\` e caractere de controle.
    const nextParam = parseSafeNext(request.nextUrl.searchParams.get('next'))
    if (nextParam) {
      return NextResponse.redirect(new URL(nextParam, request.url))
    }
    url.pathname = '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  // Protected pages - redirect to login if not authenticated.
  // Guarda o destino em ?next= pra voltar depois do login. `url.search = ''` é
  // obrigatório: o clone traz a query da rota original, e sem limpar o telefone
  // do deep-link da Plataforma MB vazaria pra URL do /login.
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const dest = request.nextUrl.pathname + request.nextUrl.search
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    const safe = parseSafeNext(dest)
    // searchParams.set percent-encoda `?`, `&` e `=` internos sozinho —
    // encodeURIComponent aqui duplicaria o encoding.
    if (safe && safe !== '/dashboard') url.searchParams.set('next', safe)
    return NextResponse.redirect(url)
  }

  // API routes that need auth (not webhooks, not o cron de inbound Evolution).
  // Allowlist ANCORADA por caminho exato (não substring): só estas duas rotas
  // ficam isentas da sessão. O webhook valida assinatura Meta; o cron valida
  // x-cron-secret (constant-time). Substring solta deixaria
  // `/api/whatsapp/evolution/cron-qualquer` furar a auth.
  const p = request.nextUrl.pathname
  const isWebhook = p === '/api/whatsapp/webhook' || p.startsWith('/api/whatsapp/webhook/')
  const isEvolutionCron = p === '/api/whatsapp/evolution/cron'
  if (!user && p.startsWith('/api/whatsapp/') && !isWebhook && !isEvolutionCron) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
