import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resumeRunOnLinkClick } from '@/lib/flows/engine'
import { consumeLinkToken } from '@/lib/link-tracking/token'
import { recordAgentClick } from '@/lib/link-tracking/agent-click'
import { isLoggedMemberClick } from '@/lib/link-tracking/member-click'
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

  // Ignora clique de membro logado da conta do token (evita clique falso do próprio
  // atendente). Fail-open: sem cookie de sessão (contato no WhatsApp) → false → conta normal.
  const isMember = await isLoggedMemberClick(_req, payload.account_id)

  try {
    // Roteamento por origem do token: link do AGENTE de IA ou do ATENDENTE (manual, sem
    // flow_run) só audita o clique; link de FLOW retoma a run como antes. Clique de membro
    // logado não é auditado (não infla o rastreio).
    if (payload.source === 'agent' || payload.source === 'manual') {
      if (!isMember) {
        await recordAgentClick(supabaseAdmin(), payload, _req.headers.get('user-agent'))
      }
    } else {
      await resumeRunOnLinkClick(
        supabaseAdmin(),
        payload,
        _req.headers.get('user-agent'),
      )
    }
  } catch (e) {
    // Nem o resume nem o registro bloqueiam o redirect.
    console.error('[link] click handling failed:', e instanceof Error ? e.message : e)
  }

  // Incrementa o badge de cliques na mensagem OUTBOUND que enviou este link
  // (realtime via messages). Fora do try — best-effort, nunca trava o redirect.
  // O bot/prefetch já retornou acima; clique de membro logado não conta (skip-membro).
  if (!isMember) {
    void supabaseAdmin()
      .rpc('increment_message_link_clicks', { p_token: token })
      .then(({ error }) => {
        if (error) console.error('[link] click badge inc failed:', error.message)
      })
  }

  return redirect()
}
