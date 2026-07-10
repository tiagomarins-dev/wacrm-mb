import type { SupabaseClient } from '@supabase/supabase-js'
import { getSiteUrl } from '@/lib/site-url'
import { findUrls } from './url-detect'
import { createManualLinkToken } from './token'

// Reescreve os links http(s) do texto do atendente em /r/<token> rastreável.
// Guardas: !text → devolve text; getSiteUrl() ausente (runtime) → devolve text (não
// quebra o envio); URL já /r/ → não re-wrapa. Substitui do FIM p/ o INÍCIO para não
// deslocar os índices ainda não processados.
export async function wrapTrackableLinks(
  db: SupabaseClient,
  text: string | null | undefined,
  args: { accountId: string; contactId: string | null },
): Promise<string | null | undefined> {
  if (!text) return text
  const base = getSiteUrl()
  if (!base) return text // SITE_URL não setado → manda cru (fallback seguro)

  const urls = findUrls(text)
  if (urls.length === 0) return text
  const prefix = `${base}/r/`

  let out = text
  for (let i = urls.length - 1; i >= 0; i--) {
    const { url, start, end } = urls[i]
    if (url.startsWith(prefix)) continue // já é /r/ → não re-wrapa
    const token = await createManualLinkToken(
      db,
      { account_id: args.accountId, contact_id: args.contactId, url },
      Date.now(),
    )
    out = out.slice(0, start) + `${prefix}${token}` + out.slice(end)
  }
  return out
}
