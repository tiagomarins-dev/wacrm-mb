import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requirePlaygroundAuth, resolvePlaygroundAccountId } from '@/lib/playground-ruth/auth'

// timingSafeEqual (node:crypto) no auth → força runtime Node.
export const runtime = 'nodejs'

// Lista os perfis de IA da conta-âncora pro playground. O payload inclui os
// prompts: a senha do playground dá acesso de TESTE a eles (perfis desabilitados
// também entram — testar prompt de perfil desligado é caso de uso legítimo).
export async function GET(request: Request) {
  const denied = requirePlaygroundAuth(request)
  if (denied) return denied
  const db = supabaseAdmin()
  const anchor = await resolvePlaygroundAccountId(db)
  if ('response' in anchor) return anchor.response
  const { data, error } = await db
    .from('ai_profiles')
    .select('id, nome, slug, enabled, persona_prompt, opening_prompt, model, allowed_tools, max_bot_turns')
    .eq('account_id', anchor.accountId)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: 'falha ao listar perfis' }, { status: 500 })

  // Base de cursos (somente leitura): dá visibilidade na página do que a Ruth
  // enxerga — o posicionamento entra no catálogo do prompt e a condição só
  // chega ao modelo quando ele chama get_curso. Inclui inativos (não aparecem
  // pro modelo) pra deixar o estado da base transparente pra quem testa.
  const { data: courses } = await db
    .from('ai_courses')
    .select('slug, nome, ativo, posicionamento, condicao_vigente, link_venda')
    .eq('account_id', anchor.accountId)
    .order('slug', { ascending: true })
  const cursos = ((courses as {
    slug: string
    nome: string
    ativo: boolean
    posicionamento: string | null
    condicao_vigente: string | null
    link_venda: string | null
  }[] | null) ?? []).map((c) => ({
    slug: c.slug,
    nome: c.nome,
    ativo: c.ativo,
    posicionamento: c.posicionamento,
    condicao_vigente: c.condicao_vigente,
    tem_link: c.link_venda !== null,
  }))

  return NextResponse.json({ profiles: data ?? [], courses: cursos })
}
