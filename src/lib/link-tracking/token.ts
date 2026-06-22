import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================
// Token de link rastreável — id ALEATÓRIO CURTO (capability) persistido
// em `link_tokens` (migration 030). Substitui o token stateless HMAC, que
// gerava URLs enormes e o WhatsApp só tornava clicável a 1ª parte (quebra
// em chars do base64). 32 hex = 128 bits → URL /r/<id> curta e 100%
// clicável. O id é a capability; a linha existir + não expirar é a checagem
// (não precisa de segredo). Destino vem do banco → sem open-redirect.
// ============================================================

const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 dias

/** Alvo da run + destino, lido na hora do clique. */
export interface LinkTokenPayload {
  flow_id: string
  run_id: string
  node_key: string
  contact_id: string | null
  url: string
}

// Cria o token (insere a linha) e devolve o id curto. `now` injetável p/ teste.
export async function createLinkToken(
  db: SupabaseClient,
  args: LinkTokenPayload & { account_id: string },
  now: number,
): Promise<string> {
  if (!/^https?:\/\//i.test(args.url)) {
    throw new Error('link url must be http(s)')
  }
  const id = crypto.randomBytes(16).toString('hex')
  const { error } = await db.from('link_tokens').insert({
    id,
    account_id: args.account_id,
    flow_id: args.flow_id,
    run_id: args.run_id,
    node_key: args.node_key,
    contact_id: args.contact_id,
    url: args.url,
    expires_at: new Date(now + TTL_MS).toISOString(),
  })
  if (error) throw new Error(`failed to create link token: ${error.message}`)
  return id
}

// (C1/P2) Token rastreável para links enviados pelo AGENTE DE IA — sem
// flow_run. Espelha createLinkToken, mas grava flow_id/run_id = null e
// source='agent'. NÃO refatora createLinkToken (caminho de flows intocado).
// Requer migration 037 (flow_id/run_id nullable + coluna source).
export async function createAgentLinkToken(
  db: SupabaseClient,
  args: { account_id: string; contact_id: string | null; url: string },
  now: number,
): Promise<string> {
  if (!/^https?:\/\//i.test(args.url)) {
    throw new Error('link url must be http(s)')
  }
  const id = crypto.randomBytes(16).toString('hex')
  const { error } = await db.from('link_tokens').insert({
    id,
    account_id: args.account_id,
    flow_id: null,
    run_id: null,
    node_key: 'agent',
    source: 'agent',
    contact_id: args.contact_id,
    url: args.url,
    expires_at: new Date(now + TTL_MS).toISOString(),
  })
  if (error) throw new Error(`failed to create agent link token: ${error.message}`)
  return id
}

// Lê o token. Inexistente/expirado/scheme inválido → null (fail-closed).
// Não apaga a linha: cliques repetidos viram no-op no resume (guard de
// current_node_key); manter a linha deixa o link funcionar dentro do TTL.
// Token consumido: superset de LinkTokenPayload com account_id + source —
// o /r usa `source` p/ rotear (flow vs agent) e `account_id` p/ o registro
// do clique do agente (que não tem run de onde puxar o account_id).
export interface ConsumedToken extends LinkTokenPayload {
  account_id: string
  source: string
}

export async function consumeLinkToken(
  db: SupabaseClient,
  id: string,
  now: number,
): Promise<ConsumedToken | null> {
  if (!id) return null
  const { data } = await db
    .from('link_tokens')
    .select('account_id, source, flow_id, run_id, node_key, contact_id, url, expires_at')
    .eq('id', id)
    .maybeSingle()
  if (!data) return null
  const row = data as {
    account_id: string
    source: string | null
    flow_id: string | null
    run_id: string | null
    node_key: string
    contact_id: string | null
    url: string
    expires_at: string
  }
  if (new Date(row.expires_at).getTime() < now) return null
  if (!/^https?:\/\//i.test(row.url)) return null
  return {
    account_id: row.account_id,
    source: row.source ?? 'flow',
    flow_id: row.flow_id as string,
    run_id: row.run_id as string,
    node_key: row.node_key,
    contact_id: row.contact_id,
    url: row.url,
  }
}
