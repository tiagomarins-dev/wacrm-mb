// ============================================================
// Troca o `code` do e-mail (confirmação/recuperação) por sessão e segue pro `next`.
// Sem esta rota, o link de confirmação cai em /?code= sem estabelecer sessão → o
// convite nunca conclui (usuário fica órfão na conta pessoal). runtime nodejs:
// exchangeCodeForSession usa cookies/PKCE (não roda em Edge).
// ============================================================
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { parseSafeNext } from '@/lib/auth/safe-next'

export const runtime = 'nodejs'

// Só aceita path relativo interno (bloqueia open-redirect: //evil, https://…).
// A validação mora em lib/auth/safe-next porque o middleware e a página de login
// consomem o mesmo `?next=` — um validador só, uma regra só.
// `/reset-password` ainda não existe (404) → desvia pro /login até a página ser criada.
function safeNext(next: string | null): string {
  const safe = parseSafeNext(next)
  if (!safe) return '/dashboard'
  if (safe.startsWith('/reset-password')) return '/login'
  return safe
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = safeNext(searchParams.get('next'))

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }
  // Falha/sem code → login. Se o destino era /join/<token>, devolve como ?invite=<token>
  // (a página de login lê `?invite=` e reencaminha pro /join após logar).
  const m = next.match(/^\/join\/([^/?#]+)/)
  const loginUrl = m ? `/login?invite=${encodeURIComponent(m[1])}` : '/login'
  return NextResponse.redirect(`${origin}${loginUrl}`)
}
