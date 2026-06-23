// ============================================================
// Ferramentas do agente (roteamento por assunto + ações).
// O LLM ROTEIA o assunto escolhendo qual tool chamar:
//   VENDAS:  get_curso, enviar_link_venda
//   SUPORTE: buscar_suporte
//   COMUM:   transferir_humano (espelha assign_conversation), encerrar
//
// SEGURANÇA (M3): as buscas filtram account_id (via knowledge.ts).
//
// DESVIO DELIBERADO da spec (reportado): enviar_link_venda NÃO envia a
// mensagem direto — minta o link rastreável e o DEVOLVE ao modelo, que o
// inclui na resposta final. Assim o envio é único e passa pelo pós-filtro
// (guardrail) e pelo recheck-humano do engine, em vez de burlar os dois.
// ============================================================
import { getCurso, searchSupport } from './knowledge'
import { createAgentLinkToken } from '@/lib/link-tracking/token'
import type { AgentCtx, AgentTopic } from './llm'

// Shape de um tool_call do OpenRouter (OpenAI-compatible).
interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}

interface ToolResult {
  output: unknown
  detectedTopic?: AgentTopic
  // Sinal de transferência: o engine reatribui a conversa DEPOIS de enviar a
  // resposta (p/ a msg de "vou te transferir" sair antes do bot sair de cena).
  // `to` = user_id do humano roteado, ou null p/ desatribuir.
  handoff?: { to: string | null }
}

// Tools de DOMÍNIO (filtráveis por allowed_tools do perfil). As de CONTROLE
// (transferir_humano, encerrar) NÃO entram aqui: são sempre incluídas, senão
// o handoff quebra (o engine depende de transferir_humano).
const DOMAIN_TOOLS = new Set(['get_curso', 'enviar_link_venda', 'buscar_suporte'])

// Definições das ferramentas no formato OpenAI (tools[]). `allowedTools` (do
// perfil) filtra SÓ as tools de domínio; null/vazio = todas. Tool desconhecida
// no array é ignorada (no-op). transferir_humano/encerrar entram sempre.
export function buildToolDefs(allowedTools?: string[] | null) {
  const all = [
    {
      type: 'function',
      function: {
        name: 'get_curso',
        description:
          'Retorna a ficha ATUAL de um curso (condição/preço, bônus, garantia, entregas). Use sempre que o cliente perguntar valor, condição ou detalhe de um curso. NUNCA invente esses dados.',
        parameters: {
          type: 'object',
          properties: { slug: { type: 'string', description: 'slug do curso (ex: metodo-blindado-intensivo)' } },
          required: ['slug'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'enviar_link_venda',
        description:
          'Gera o link de matrícula rastreável de um curso. Retorna a URL: inclua-a na sua resposta para o cliente.',
        parameters: {
          type: 'object',
          properties: { slug: { type: 'string', description: 'slug do curso' } },
          required: ['slug'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'buscar_suporte',
        description:
          'Busca na base de suporte (acesso, plataforma, financeiro, correção, aulas). Use para dúvidas de aluno. Se vier vazio, use transferir_humano.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: 'termos da dúvida do cliente' } },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'transferir_humano',
        description:
          'Transfere a conversa para um atendente humano. Use quando o cliente pedir, quando a base não tiver resposta, ou em caso sensível (financeiro/reclamação).',
        parameters: {
          type: 'object',
          properties: {
            assunto: { type: 'string', enum: ['vendas', 'suporte'], description: 'time de destino' },
            motivo: { type: 'string', description: 'motivo curto da transferência' },
          },
          required: ['assunto'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'encerrar',
        description: 'Finaliza o turno sem ação adicional (ex.: cliente só agradeceu).',
        parameters: { type: 'object', properties: { motivo: { type: 'string' } } },
      },
    },
  ]
  // Sem allowed_tools = todas. Com lista: filtra só as de domínio; controle fica.
  if (!allowedTools || allowedTools.length === 0) return all
  const allow = new Set(allowedTools)
  return all.filter((t) => !DOMAIN_TOOLS.has(t.function.name) || allow.has(t.function.name))
}

// Executa uma tool pedida pelo modelo e devolve o resultado + assunto detectado.
export async function execTool(ctx: AgentCtx, call: ToolCall): Promise<ToolResult> {
  const name = call.function?.name
  let args: Record<string, unknown> = {}
  try {
    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
  } catch {
    return { output: { error: 'argumentos inválidos' } }
  }

  switch (name) {
    case 'get_curso': {
      const curso = await getCurso(ctx.db, ctx.accountId, String(args.slug ?? ''))
      if (!curso) return { output: { error: 'curso não encontrado' }, detectedTopic: 'vendas' }
      // Devolve só os campos que o agente pode falar (a ficha é a fonte de verdade).
      return {
        output: {
          nome: curso.nome,
          posicionamento: curso.posicionamento,
          publico: curso.publico,
          entregas: curso.entregas,
          numeros_claims: curso.numeros_claims,
          condicao_vigente: curso.condicao_vigente,
          bonus: curso.bonus,
          garantia: curso.garantia,
          nao_prometer: curso.nao_prometer,
          pagina_vendas_url: curso.pagina_vendas_url,
        },
        detectedTopic: 'vendas',
      }
    }

    case 'enviar_link_venda': {
      const curso = await getCurso(ctx.db, ctx.accountId, String(args.slug ?? ''))
      if (!curso?.link_venda) {
        // Sem link NÃO é erro técnico: a matrícula desse curso é feita pela
        // equipe. Sinaliza ao modelo p/ oferecer transferir, sem falar em erro.
        return {
          output: {
            sem_link: true,
            mensagem:
              'Este curso ainda não tem link de matrícula automático; a matrícula é feita pela equipe. Ofereça transferir para um atendente concluir, sem mencionar erro ou problema técnico.',
          },
          detectedTopic: 'vendas',
        }
      }
      const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '')
      if (!base) return { output: { error: 'site url não configurada' }, detectedTopic: 'vendas' }
      const token = await createAgentLinkToken(
        ctx.db,
        { account_id: ctx.accountId, contact_id: ctx.contactId, url: curso.link_venda },
        Date.now(),
      )
      return { output: { url: `${base}/r/${token}`, curso: curso.nome }, detectedTopic: 'vendas' }
    }

    case 'buscar_suporte': {
      const artigos = await searchSupport(ctx.db, ctx.accountId, String(args.query ?? ''))
      if (artigos.length === 0) {
        return { output: { results: [], hint: 'sem resultado — use transferir_humano' }, detectedTopic: 'suporte' }
      }
      return {
        output: { results: artigos.map((a) => ({ titulo: a.titulo, conteudo: a.conteudo })) },
        detectedTopic: 'suporte',
      }
    }

    case 'transferir_humano': {
      // NÃO reatribui aqui — só sinaliza. O engine reatribui DEPOIS de enviar
      // a resposta (assim a msg de "vou te transferir" sai antes de o bot
      // deixar de ser o responsável). `to` = humano roteado ou null (desatribui).
      const assunto = (args.assunto === 'suporte' ? 'suporte' : 'vendas') as 'vendas' | 'suporte'
      const agentId = ctx.handoffRouting?.[assunto] ?? null
      return {
        output: { ok: true, assunto, encaminhado_para: agentId ? 'time' : 'fila' },
        detectedTopic: assunto,
        handoff: { to: agentId },
      }
    }

    case 'encerrar':
      return { output: { ok: true } }

    default:
      return { output: { error: `tool desconhecida: ${name}` } }
  }
}
