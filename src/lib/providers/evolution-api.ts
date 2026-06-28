// ============================================================
// Cliente HTTP da Evolution API (WhatsApp Web via Baileys). Funções
// puras, named-args (espelha o estilo de meta-api.ts). Auth = header
// `apikey` com a chave GLOBAL da Evolution (env EVOLUTION_API_KEY).
//
// ⚠️ Shapes baseados na Evolution v2.3.7 (+ repo meu_whatsapp). Se a
// resposta da instância divergir, ajustar os acessos defensivos abaixo.
// ============================================================

interface EvoBase {
  baseUrl: string
  apiKey: string
  instance: string
}

// Request + erro normalizado (espelha throwMetaError de meta-api.ts).
async function evoFetch(
  url: string,
  apiKey: string,
  init?: RequestInit,
): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: apiKey,
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Evolution API error: ${res.status} ${body}`)
  }
  return res.json()
}

// Extrai o base64 do QR de formatos conhecidos da Evolution.
function pickQrBase64(data: unknown): string | null {
  const d = data as { base64?: string; qrcode?: { base64?: string } } | null
  return d?.base64 ?? d?.qrcode?.base64 ?? null
}

// Cria (ou reusa) a instância e já pede o QR. Retorna o base64 do QR.
export async function evoCreateInstance(a: {
  baseUrl: string
  apiKey: string
  instanceName: string
}): Promise<{ qrBase64: string | null }> {
  const data = await evoFetch(`${a.baseUrl}/instance/create`, a.apiKey, {
    method: 'POST',
    body: JSON.stringify({
      instanceName: a.instanceName,
      integration: 'WHATSAPP-BAILEYS',
      qrcode: true,
    }),
  })
  return { qrBase64: pickQrBase64(data) }
}

// Pede um QR novo p/ uma instância existente (o QR expira ~60s).
export async function evoConnect(a: EvoBase): Promise<{ qrBase64: string | null }> {
  const data = await evoFetch(`${a.baseUrl}/instance/connect/${a.instance}`, a.apiKey)
  return { qrBase64: pickQrBase64(data) }
}

// Estado da conexão: 'open' (conectada) | 'connecting' | 'close'.
export async function evoConnectionState(a: EvoBase): Promise<{ state: string }> {
  const data = (await evoFetch(
    `${a.baseUrl}/instance/connectionState/${a.instance}`,
    a.apiKey,
  )) as { instance?: { state?: string }; state?: string } | null
  return { state: data?.instance?.state ?? data?.state ?? 'close' }
}

// Shape (validado no container v2.3.7) de um record de /chat/findMessages.
export interface EvoRecord {
  // remoteJidAlt traz o telefone real (@s.whatsapp.net) quando o remoteJid
  // vem como @lid (linked identity / privacidade nova do WhatsApp).
  key?: {
    id?: string
    fromMe?: boolean
    remoteJid?: string
    remoteJidAlt?: string
    addressingMode?: string
  }
  pushName?: string
  messageType?: string
  message?: {
    conversation?: string
    extendedTextMessage?: { text?: string }
    imageMessage?: { caption?: string }
    videoMessage?: { caption?: string }
    documentMessage?: { caption?: string }
    [k: string]: unknown
  }
  messageTimestamp?: number | string
}

// Busca mensagens da instância (Evolution persiste no MySQL próprio).
// Retorna os records crus; o filtro (fromMe/since) e a normalização são
// do chamador. Validado no container: { messages: { records: [...] } }.
export async function evoFetchMessages(a: EvoBase): Promise<EvoRecord[]> {
  const data = (await evoFetch(`${a.baseUrl}/chat/findMessages/${a.instance}`, a.apiKey, {
    method: 'POST',
    body: JSON.stringify({ where: {} }),
  })) as { messages?: { records?: EvoRecord[] } } | null
  return data?.messages?.records ?? []
}

// Baixa a mídia de uma mensagem como base64 (p/ subir no bucket).
// ⚠️ endpoint/shape a validar no container: /chat/getBase64FromMediaMessage/{instance}.
export async function evoBase64FromMedia(
  a: EvoBase & { messageKeyId: string },
): Promise<{ base64: string; mimetype: string } | null> {
  const data = (await evoFetch(
    `${a.baseUrl}/chat/getBase64FromMediaMessage/${a.instance}`,
    a.apiKey,
    { method: 'POST', body: JSON.stringify({ message: { key: { id: a.messageKeyId } } }) },
  )) as { base64?: string; mimetype?: string } | null
  if (!data?.base64) return null
  return { base64: data.base64, mimetype: data.mimetype ?? 'application/octet-stream' }
}

// Envia texto 1:1. `number` = telefone só-dígitos. Retorna o id da msg.
export async function evoSendText(
  a: EvoBase & { number: string; text: string },
): Promise<{ messageId: string }> {
  const data = (await evoFetch(`${a.baseUrl}/message/sendText/${a.instance}`, a.apiKey, {
    method: 'POST',
    body: JSON.stringify({ number: a.number, text: a.text }),
  })) as { key?: { id?: string } } | null
  return { messageId: data?.key?.id ?? '' }
}
