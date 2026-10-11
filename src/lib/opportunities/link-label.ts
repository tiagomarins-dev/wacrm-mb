// ============================================================
// link-label.ts — rótulo curto do link clicado, para a lista de Oportunidades.
//
// Mostra domínio + caminho, sem protocolo, "www." nem parâmetros: é o trecho
// que identifica a oferta (ex.: "pay.hotmart.com/O106563458B",
// "bit.ly/maratonamb-zap-atendimento"). Os parâmetros de rastreio alongam a
// linha sem ajudar o atendente.
// ============================================================

// URL inválida volta como veio: o dado continua visível em vez de sumir.
export function linkLabel(url: string): string {
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./i, '')
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}`
  } catch {
    return url
  }
}
