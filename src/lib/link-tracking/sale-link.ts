// ============================================================
// sale-link.ts — decide se um link enviado à mão é link de venda.
//
// É de venda o link que leva ao checkout da Hotmart ou que é o link de
// matrícula de algum curso do agente de IA (ai_courses.link_venda). O segundo
// caso cobre curso vendido por encurtador ou página própria, que não passa por
// pay.hotmart.com.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'

const CHECKOUT_HOST = 'pay.hotmart.com'

// Compara sem a barra final: "https://x.com/a" e "https://x.com/a/" são o mesmo link.
function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

// Puro: `courseLinks` são os link_venda dos cursos da conta.
export function isSaleUrl(url: string, courseLinks: readonly string[]): boolean {
  try {
    if (new URL(url).hostname.toLowerCase() === CHECKOUT_HOST) return true
  } catch {
    return false
  }
  const target = normalize(url)
  return courseLinks.some((link) => normalize(link) === target)
}

// Links de matrícula dos cursos da conta. Falha na leitura devolve lista vazia:
// o envio da mensagem segue e só o checkout da Hotmart é reconhecido.
export async function loadCourseSaleLinks(db: SupabaseClient, accountId: string): Promise<string[]> {
  const { data, error } = await db
    .from('ai_courses')
    .select('link_venda')
    .eq('account_id', accountId)
    .not('link_venda', 'is', null)
  if (error) {
    console.error('[link] course sale links load failed:', error.message)
    return []
  }
  return ((data ?? []) as { link_venda: string | null }[])
    .map((r) => r.link_venda)
    .filter((l): l is string => !!l)
}
