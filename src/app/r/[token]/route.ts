import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resumeRunOnLinkClick } from '@/lib/flows/engine'
import { consumeLinkToken } from '@/lib/link-tracking/token'
import { isBotUserAgent } from '@/lib/link-tracking/user-agent'

export const runtime = 'nodejs'

// ============================================================
// Redirect de link rastreável (público, sem auth — não está em
// protectedPaths nem /api/whatsapp, então o middleware deixa passar).
// Rota FINA: verifica token → filtra bot → retoma o flow → 302 pro
// destino. O insert de link_clicks mora no resume (tem account_id da run).
// ============================================================
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const payload = await consumeLinkToken(supabaseAdmin(), token, Date.now())
  // Token inexistente/expirado: 404 (destino só vem do banco → sem
  // open-redirect).
  if (!payload) return new Response('Not found', { status: 404 })

  // Sempre redireciona pra URL ASSINADA no token, mesmo se o resume
  // falhar (o clique nunca pode quebrar pro usuário).
  const redirect = () => Response.redirect(payload.url, 302)

  // Bot/prefetch (preview do WhatsApp pré-carrega a URL) ou método != GET:
  // 302 direto, sem contar nem retomar.
  if (_req.method !== 'GET' || isBotUserAgent(_req.headers.get('user-agent'))) {
    return redirect()
  }

  try {
    await resumeRunOnLinkClick(
      supabaseAdmin(),
      payload,
      _req.headers.get('user-agent'),
    )
  } catch (e) {
    // Resume nunca bloqueia o redirect.
    console.error('[link] resume failed:', e instanceof Error ? e.message : e)
  }
  return redirect()
}
