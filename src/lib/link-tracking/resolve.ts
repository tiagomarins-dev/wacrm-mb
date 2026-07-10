import type { SupabaseClient } from '@supabase/supabase-js'

// Resolve tokens → URL original, ESCOPADO à conta (token de outra conta some do mapa).
// Cap e filtro de formato são aplicados no route handler; aqui, só a leitura.
export async function resolveTokens(
  db: SupabaseClient,
  accountId: string,
  tokens: string[],
): Promise<Record<string, string>> {
  if (tokens.length === 0) return {}
  const { data } = await db
    .from('link_tokens')
    .select('id, url')
    .in('id', tokens)
    .eq('account_id', accountId)
  return Object.fromEntries(
    (data ?? []).map((r) => [r.id as string, r.url as string]),
  )
}
