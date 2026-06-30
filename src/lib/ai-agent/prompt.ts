// ============================================================
// Montagem do system prompt do agente + serialização do histórico.
// Ordem anti prompt-injection: papel → persona (admin) → VOZ_MILLA
// (guardrails têm precedência, vêm DEPOIS) → roteamento → catálogo →
// contexto do contato → política de handoff → diretriz de abertura
// (último, precedência máxima: cumprimenta+pergunta, sem transferir).
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
  // Dados do contato p/ personalização (nome/email) + cursos que o aluno já tem.
  contactName?: string | null
  contactEmail?: string | null
  studentCourses?: string[]
  // Modo abertura (entrada via passo ai_reply): a IA inicia o atendimento
  // cumprimentando e perguntando, SEM transferir nesta 1ª resposta.
  opening?: boolean
}

// Monta o system prompt concatenando as camadas na ordem de precedência.
export function buildSystemPrompt(args: BuildPromptArgs): string {
  const parts: string[] = []

  // 1+2+3) Base do prompt. Se o perfil tem persona PRÓPRIA (ex.: a "Ruth",
  // que já traz nome/voz/regras completas), ela é a base e NÃO somamos o papel
  // genérico nem o VOZ_MILLA (evita duplicar/contradizer — o pós-filtro
  // guardrail.ts segue como rede de segurança). Sem persona: papel + voz-milla.
  if (args.persona?.trim()) {
    parts.push(args.persona.trim())
  } else {
    parts.push(
      'Você é a assistente virtual da Prof. Milla Borges no WhatsApp. Atende tanto leads (vendas) quanto alunos (suporte). Identifica o assunto, busca na base certa, responde com informação atual, conduz à matrícula quando é venda, resolve a dúvida quando é suporte, e transfere para um humano quando necessário.',
    )
    parts.push(VOZ_MILLA)
  }

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

  // 5.1) Venda CONSULTIVA: usar a dor da pessoa, construir valor ANTES do preço.
  parts.push(
    'VENDAS (você é uma VENDEDORA consultiva, NÃO um balcão de informação): NUNCA ignore o que a pessoa acabou de te contar. Quando ela disser a dificuldade dela (ex: argumentação, repertório, falta de tempo), ACOLHA e mostre em 1 ou 2 frases curtas como a Milla resolve EXATAMENTE aquilo (a correção humana mostra onde o ponto escapa; o método blinda ali) — gerando desejo. NÃO lidere pela condição/preço: só passe o valor quando a pessoa demonstrar interesse claro OU pedir o valor. Ao informar valor, PRIORIZE a parcela em 12x (o à vista é secundário). Quando a pessoa presta MAIS DE UM vestibular, ofereça o COMBO certo (ENEM e UERJ = Carioca; ENEM e FUVEST = Paulista; ENEM, UERJ e FUVEST = Brasil) e enfatize a economia frente ao separado. Use get_curso pelo slug para os valores reais. Conduza a conversa: acolher a dor, criar valor, então convidar pra matrícula.',
  )

  // 5.2) Estilo de resposta: breve e humano, mas SEM virar seco (multi-bolha).
  parts.push(
    'ESTILO DE RESPOSTA (MUITO IMPORTANTE): seja BREVE e natural, como uma pessoa real digitando no WhatsApp, NÃO como robô nem texto de site. No máximo 2 ou 3 frases curtas por resposta. Breve NÃO é seco: você ainda acolhe e conduz a venda, só não dá AULA de redação (o aluno já sabe o que importa) nem escreve parágrafos longos. Separe ideias em parágrafos curtos com UMA linha em branco entre eles: cada parágrafo vira uma mensagem separada no WhatsApp, então quebre como gente quebra a fala em várias mensagens. Uma única pergunta, no final.',
  )

  // 6) Dados do contato (personalização): nome p/ tratar pela alça, email p/
  //    conferência, e os cursos que o aluno já possui (não revender o mesmo).
  const contatoLinhas: string[] = []
  if (args.contactName?.trim()) contatoLinhas.push(`Nome: ${args.contactName.trim()}`)
  if (args.contactEmail?.trim()) contatoLinhas.push(`Email cadastrado: ${args.contactEmail.trim()}`)
  if (args.studentCourses?.length) {
    contatoLinhas.push(`Cursos e módulos que JÁ possui: ${args.studentCourses.join('; ')}`)
  }
  if (contatoLinhas.length) {
    parts.push(
      'DADOS DO CONTATO (use o NOME para personalizar, tratando a pessoa pelo nome desde já. NÃO repita o email sem a pessoa pedir. Se ele JÁ possui um curso, NÃO ofereça o mesmo curso de novo: foque em suporte e próximos passos):\n' +
        contatoLinhas.join('\n'),
    )
  }

  // Sinal de roteamento: aluno tende a SUPORTE.
  const isAluno = !!args.studentCourses?.length || args.student?.status === 'success'
  if (isAluno) {
    parts.push(
      'Este contato JÁ É ALUNO. Dúvidas dele tendem a ser de suporte; use buscar_suporte. Mesmo assim, deixe o ASSUNTO da mensagem decidir.',
    )
  }

  // 7) Política de handoff.
  parts.push(
    'HANDOFF: transfira para um humano (transferir_humano) quando o cliente pedir um atendente, quando a busca na base não tiver resposta, ou em caso financeiro/reclamação sensível. Caso contrário, conduza você mesma.',
  )

  // 7.1) Uso correto do encerrar (evita "parar de responder" no meio da venda).
  parts.push(
    'ENCERRAR: só use a ferramenta encerrar quando o cliente claramente terminou a conversa (agradeceu ou se despediu). Se ele fez QUALQUER pergunta ou pediu algo — inclusive desconto, cupom melhor ou condição — você DEVE responder com texto. Nunca encerre calado diante de uma pergunta: se não puder dar mais desconto, diga isso e reforce o valor.',
  )

  // 8) Formatação WhatsApp: texto corrido, SEM markdown (o WhatsApp não
  //    renderiza e o asterisco aparece literal pro cliente).
  parts.push(
    'FORMATAÇÃO (WhatsApp): escreva texto corrido e simples, SEM markdown — nada de asteriscos (* ou **) para negrito, nada de #, hífens ou números como marcadores de lista, nem links entre colchetes. Escreva o link cru (https://...). Mensagens curtas, com quebra de linha entre as frases. Se um curso não tiver link de matrícula, NÃO diga que houve erro técnico — diga que a matrícula desse curso é feita pela equipe e ofereça transferir para um atendente.',
  )

  // 9) ABERTURA (precedência máxima — vem por último): a IA inicia o atendimento
  //    cumprimentando e perguntando, sem transferir nesta 1ª resposta. Sobrepõe a
  //    persona roteadora e PROÍBE qualquer texto de encaminhamento.
  if (args.opening) {
    parts.push(
      'ABERTURA DE NOVA CONVERSA (REGRA QUE SOBREPÕE SUA PERSONA NESTA RESPOSTA): esta é a sua PRIMEIRA mensagem neste atendimento. Sua ÚNICA tarefa agora é cumprimentar a pessoa pelo nome (se houver), apresentar-se em uma linha e FAZER UMA pergunta aberta de como pode ajudar hoje. Use o histórico apenas como contexto de fundo — NÃO aja sobre ele. É PROIBIDO nesta resposta: transferir ou encaminhar, chamar transferir_humano, dizer que um analista/atendente/a equipe vai atender, ou usar as palavras "transferir", "encaminhar", "analista", "atendente" ou "equipe". Apenas cumprimente e pergunte. Espere a pessoa dizer o que precisa antes de qualquer encaminhamento.',
    )
  }

  return parts.join('\n\n')
}

// Mínimo que o serializador precisa da row de messages.
interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: string | null
  // Transcrição automática de áudio (migration 046).
  transcription: string | null
  transcription_status: string | null
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
      // Usa a transcrição automática (migration 046) quando pronta — assim o
      // agente "lê" o áudio em vez de só ver um placeholder. 'empty' = áudio
      // sem fala compreensível; pending/running/failed/null = ainda sem texto.
      if (m.transcription_status === 'done' && m.transcription?.trim()) {
        return m.transcription.trim()
      }
      if (m.transcription_status === 'empty') return '[áudio sem conteúdo]'
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
    .select('sender_type, content_text, content_type, created_at, transcription, transcription_status')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error || !data) {
    if (error) console.error('[ai_agent] serializeRecentMessages failed:', error.message)
    return []
  }
  // Veio em ordem decrescente p/ pegar as N mais recentes; reinverte p/ cronológica.
  const rows = (data as DbMessage[]).slice().reverse()
  return coalesceHistory(
    rows.map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: bodyOf(m),
    })),
  )
}

// Normaliza o histórico p/ provedores estritos (Anthropic via OpenRouter):
// (1) descarta conteúdo vazio; (2) dropa o PREFIXO que não seja 'user' (a 1ª
// mensagem após o system tem que ser do usuário); (3) mescla mensagens
// CONSECUTIVAS do mesmo papel juntando o texto (multi-bolha do bot vira 1 turn
// assistant); (4) dropa o SUFIXO non-user (a IA vai gerar o assistant → o
// histórico termina no turno do usuário). Sem isso, 'assistant' adjacentes ou
// sufixo assistant → 400 da Anthropic. Histórico sem nenhum 'user' → [] (o
// engine trata como skipped:no_history).
export function coalesceHistory(msgs: ChatMsg[]): ChatMsg[] {
  const out: ChatMsg[] = []
  for (const m of msgs) {
    if (!m.content || !m.content.trim()) continue            // (1) vazio
    if (out.length === 0 && m.role !== 'user') continue       // (2) prefixo non-user
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      prev.content = `${prev.content}\n${m.content}`           // (3) mescla consecutivos
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  while (out.length && out[out.length - 1].role !== 'user') out.pop() // (4) termina em user
  return out
}
