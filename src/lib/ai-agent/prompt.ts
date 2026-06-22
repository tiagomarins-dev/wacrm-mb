// ============================================================
// Montagem do system prompt do agente + serialização do histórico.
// Ordem anti prompt-injection: papel → persona (admin) → VOZ_MILLA
// (guardrails têm precedência, vêm DEPOIS) → roteamento → catálogo →
// contexto do contato → política de handoff.
// ============================================================
import type { SupabaseClient } from '@supabase/supabase-js'
import { VOZ_MILLA } from './voz-milla'

// Mensagem no formato de chat do LLM (OpenAI-compatible).
export interface ChatMsg {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  // campos de tool-calling preenchidos no loop (llm.ts) — opcionais aqui.
  tool_call_id?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool_calls?: any[]
}

interface BuildPromptArgs {
  persona: string | null
  courses: { slug: string; nome: string; posicionamento: string | null }[]
  supportCategories: string[]
  student: { status: string | null; payload: unknown } | null
}

// Monta o system prompt concatenando as camadas na ordem de precedência.
export function buildSystemPrompt(args: BuildPromptArgs): string {
  const parts: string[] = []

  // 1) Papel + objetivo.
  parts.push(
    'Você é a assistente virtual da Prof. Milla Borges no WhatsApp. Atende tanto leads (vendas) quanto alunos (suporte). Identifica o assunto, busca na base certa, responde com informação atual, conduz à matrícula quando é venda, resolve a dúvida quando é suporte, e transfere para um humano quando necessário.',
  )

  // 2) Persona editável do admin (pode estar vazia).
  if (args.persona?.trim()) parts.push(args.persona.trim())

  // 3) VOZ_MILLA DEPOIS da persona — guardrails de marca têm precedência
  //    (se a persona contradisser, a voz/guardrails ganham).
  parts.push(VOZ_MILLA)

  // 4) Instrução-chave de roteamento por assunto.
  parts.push(
    'ROTEAMENTO: antes de afirmar qualquer dado factual, identifique se o assunto é VENDAS (preço, cursos, matrícula, condições, bônus) ou SUPORTE (acesso, plataforma, financeiro de aluno, correção, como assistir aula). Para VENDAS, use as ferramentas get_curso / enviar_link_venda. Para SUPORTE, use buscar_suporte. NUNCA responda dado factual de memória: sempre busque na ferramenta. Se o assunto não couber em nenhuma base ou a busca não trouxer resposta, use transferir_humano em vez de inventar.',
  )

  // 5) Catálogo disponível (resumo; ficha completa só via ferramenta).
  if (args.courses.length) {
    const lista = args.courses
      .map((c) => `- ${c.nome} (slug: ${c.slug})${c.posicionamento ? ` — ${c.posicionamento}` : ''}`)
      .join('\n')
    parts.push(`Cursos disponíveis (use get_curso pelo slug para a ficha atual):\n${lista}`)
  }
  if (args.supportCategories.length) {
    parts.push(`Categorias de suporte: ${args.supportCategories.join(', ')}.`)
  }

  // 6) Contexto do contato (sinal de roteamento — aluno tende a SUPORTE).
  if (args.student && args.student.status === 'success') {
    parts.push(
      'Este contato JÁ É ALUNO (consta na base de alunos). Dúvidas dele tendem a ser de suporte; trate com cuidado e use buscar_suporte. Mesmo assim, deixe o ASSUNTO da mensagem decidir.',
    )
  }

  // 7) Política de handoff.
  parts.push(
    'HANDOFF: transfira para um humano (transferir_humano) quando o cliente pedir um atendente, quando a busca na base não tiver resposta, ou em caso financeiro/reclamação sensível. Caso contrário, conduza você mesma.',
  )

  // 8) Formatação WhatsApp (sem markdown — o WhatsApp não renderiza).
  parts.push(
    'FORMATAÇÃO (WhatsApp): para negrito use UM asterisco em volta da palavra (ex: *Mestres da UERJ*), NUNCA dois (**). Não use markdown: nada de ##, listas com "-" ou "1." no início da linha, nem [texto](link). Escreva o link cru (https://...). Mensagens curtas, parágrafos curtos; evite listas longas. Se um curso não tiver link de matrícula, NÃO diga que houve erro ou problema técnico — diga que a matrícula desse curso é feita pela equipe e ofereça transferir para um atendente concluir.',
  )

  return parts.join('\n\n')
}

// Mínimo que o serializador precisa da row de messages.
interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: string | null
}

// Mapeia uma mensagem do banco p/ placeholder quando não tem texto (mídia).
function bodyOf(m: DbMessage): string {
  const t = m.content_text?.trim()
  if (t) return t
  switch (m.content_type) {
    case 'image':
      return '[imagem]'
    case 'document':
      return '[documento]'
    case 'audio':
      return '[áudio]'
    case 'video':
      return '[vídeo]'
    case 'location':
      return '[localização]'
    default:
      return '[mensagem]'
  }
}

// Busca as últimas N mensagens da conversa e mapeia p/ histórico de chat do LLM.
// customer → user; agent/bot → assistant. Mídia vira placeholder (v1 texto).
export async function serializeRecentMessages(
  db: SupabaseClient,
  conversationId: string,
  limit = 30,
): Promise<ChatMsg[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_text, content_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || !data) {
    if (error) console.error('[ai_agent] serializeRecentMessages failed:', error.message)
    return []
  }
  // Veio em ordem decrescente p/ pegar as N mais recentes; reinverte p/ cronológica.
  const rows = (data as DbMessage[]).slice().reverse()
  return rows.map((m) => ({
    role: m.sender_type === 'customer' ? 'user' : 'assistant',
    content: bodyOf(m),
  }))
}
