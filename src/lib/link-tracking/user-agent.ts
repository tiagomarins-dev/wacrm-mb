// Filtro de bots/prefetch. WhatsApp (e outros) pré-carregam a URL pra
// gerar preview do link → bateria de GETs ANTES do clique humano. Esses
// não devem contar nem retomar o flow. UA ausente = tratado como bot
// (conservador: melhor não disparar do que disparar errado).
const BOT_PATTERNS = [
  /facebookexternalhit/i,
  /WhatsApp/i,
  /bot/i,
  /preview/i,
  /crawler/i,
  /spider/i,
  /Twitterbot/i,
  /Slackbot/i,
  /TelegramBot/i,
  /Discordbot/i,
]

export function isBotUserAgent(ua: string | null | undefined): boolean {
  if (!ua) return true
  return BOT_PATTERNS.some((re) => re.test(ua))
}
