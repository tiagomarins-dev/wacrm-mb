// ============================================================
// Camada de conhecimento do agente — isola "qual base / como busca" do
// engine e das tools. Trocar a busca ilike por RAG (pgvector) no futuro
// só toca este arquivo, não o loop nem as tools.
//
// SEGURANÇA (M3): o agente roda sob service-role (RLS bypass). Toda
// consulta filtra account_id explícito — defense-in-depth, igual
// src/lib/automations/meta-send.ts e engine.ts.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiCourse, AiSupportArticle } from '@/types'

// Busca a ficha de um curso ativo da conta (base de VENDAS).
// Retorna null se não existe / não é da conta / está inativo.
export async function getCurso(
  db: SupabaseClient,
  accountId: string,
  slug: string,
): Promise<AiCourse | null> {
  const { data, error } = await db
    .from('ai_courses')
    .select('*')
    .eq('account_id', accountId)
    .eq('slug', slug)
    .eq('ativo', true)
    .maybeSingle()
  if (error) {
    console.error('[ai_agent] getCurso failed:', error.message)
    return null
  }
  return (data as AiCourse | null) ?? null
}

// Lista resumida dos cursos ativos da conta (catálogo p/ o prompt).
export async function listCursos(
  db: SupabaseClient,
  accountId: string,
): Promise<Pick<AiCourse, 'slug' | 'nome' | 'posicionamento'>[]> {
  const { data } = await db
    .from('ai_courses')
    .select('slug, nome, posicionamento')
    .eq('account_id', accountId)
    .eq('ativo', true)
  return (data as Pick<AiCourse, 'slug' | 'nome' | 'posicionamento'>[] | null) ?? []
}

// Busca artigos de SUPORTE por termo. v1: match simples (ilike) em
// titulo/keywords/conteudo. v2: trocar por busca semântica (pgvector)
// sem mudar a assinatura. Vazio => o engine sinaliza transferir (não inventa).
export async function searchSupport(
  db: SupabaseClient,
  accountId: string,
  query: string,
  limit = 3,
): Promise<AiSupportArticle[]> {
  const term = query.trim()
  if (!term) return []
  // Escapa curingas do LIKE p/ não tratar % e _ do usuário como wildcard.
  const safe = term.replace(/[%_]/g, (m) => `\\${m}`)
  const pattern = `%${safe}%`
  const { data, error } = await db
    .from('ai_support_articles')
    .select('*')
    .eq('account_id', accountId)
    .eq('ativo', true)
    .or(`titulo.ilike.${pattern},keywords.ilike.${pattern},conteudo.ilike.${pattern}`)
    .limit(limit)
  if (error) {
    console.error('[ai_agent] searchSupport failed:', error.message)
    return []
  }
  return (data as AiSupportArticle[] | null) ?? []
}

// Categorias de suporte ativas (catálogo p/ o prompt de roteamento).
export async function listSupportCategories(
  db: SupabaseClient,
  accountId: string,
): Promise<string[]> {
  const { data } = await db
    .from('ai_support_articles')
    .select('categoria')
    .eq('account_id', accountId)
    .eq('ativo', true)
  const cats = (data as { categoria: string }[] | null) ?? []
  return [...new Set(cats.map((c) => c.categoria))]
}
