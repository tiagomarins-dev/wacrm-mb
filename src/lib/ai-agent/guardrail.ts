// ============================================================
// Pós-filtro de marca (rede de segurança DEPOIS do LLM, antes de enviar).
// O controle primário é o prompt (voz-milla.ts); este filtro é o backstop
// determinístico para as barreiras vermelhas que escapam.
//
// Faz só substituições SEGURAS (não muda o sentido): troca o vocabulário
// comercial frio pelo da Milla e remove travessão. Casos ambíguos ficam
// para o prompt — aqui não tentamos reescrever frases inteiras.
// ============================================================

// Mapa de termo proibido → substituto válido (barreiras vermelhas da voz-milla).
// Ordem importa: formas mais longas antes das curtas ("comprar" antes de "compra").
const SWAPS: [RegExp, string][] = [
  [/\bcomprar\b/giu, 'garantir'],
  [/\bcompra\b/giu, 'matrícula'],
  [/\binvestimento\b/giu, 'condição'],
  [/\bpre[çc]o\b/giu, 'valor da matrícula'],
  [/\bpagar\b/giu, 'garantir'],
]

// Remove markdown da resposta. O WhatsApp não renderiza e o gpt-4o-mini insiste
// em usar (negrito **, listas, títulos), aparecendo literal pro cliente. Garantia
// determinística — a instrução do prompt sozinha não basta.
export function stripMarkdown(text: string): string {
  return (
    text
      // títulos "## Título" → "Título"
      .replace(/^#{1,6}\s+/gm, '')
      // marcadores de lista no início da linha: "- ", "* ", "1. " → ""
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      // links [texto](url) → "texto url"
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 $2')
      // ênfase **x** / *x* / __x__ / _x_ → x
      .replace(/(\*\*|__)([^*_\n]+)\1/g, '$2')
      .replace(/(\*|_)([^*_\n]+)\1/g, '$2')
      // asteriscos/sublinhados soltos que sobraram
      .replace(/\*/g, '')
      // colapsa 3+ quebras de linha em 2
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

// Aplica o pós-filtro: remove markdown, troca termos proibidos e normaliza
// travessão. Preserva a capitalização inicial da palavra trocada.
export function applyGuardrail(text: string): string {
  let out = stripMarkdown(text)

  // Travessão (— em dash, – en dash) → vírgula. A Milla nunca usa travessão.
  out = out.replace(/\s*[—–]\s*/g, ', ')

  for (const [re, repl] of SWAPS) {
    out = out.replace(re, (match) => {
      // Mantém maiúscula inicial se o termo original começava com maiúscula.
      const isCapitalized = match[0] === match[0].toUpperCase() && match[0] !== match[0].toLowerCase()
      return isCapitalized ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl
    })
  }
  return out
}

// Detecta se o texto contém termo proibido / travessão (p/ logar quando o LLM
// escapa, mesmo após a troca). Útil para métricas de aderência à voz.
export function hasForbidden(text: string): boolean {
  if (/[—–]/.test(text)) return true
  return SWAPS.some(([re]) => {
    re.lastIndex = 0
    return re.test(text)
  })
}
