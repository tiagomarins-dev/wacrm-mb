// ============================================================
// Predicado de scroll do inbox: o usuário está "colado no fim" do
// histórico? Usado p/ o auto-scroll só puxar pro fim quando ele já
// estava no fim (senão respeita a leitura do histórico). Puro/testável.
// ============================================================

// Distância (px) do fim abaixo da qual consideramos o usuário no fim.
export const NEAR_BOTTOM_PX = 80

// Estrutural (não exige HTMLElement) — testável sem DOM.
export function isNearBottom(
  el: { scrollHeight: number; scrollTop: number; clientHeight: number },
  thresholdPx: number = NEAR_BOTTOM_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx
}
