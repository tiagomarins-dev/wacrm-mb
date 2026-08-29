import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Conexão de Suporte — a que o link externo da Plataforma MB sempre abre.
 *
 * Existe separado de `resolveOutboundConfig` (connections/resolve.ts) porque as
 * duas resolvem coisas diferentes: lá o fallback pra conexão primária é feature
 * (o envio nunca pode quebrar durante o rollout); aqui é defeito. O link vem de
 * fora, decidido por outro sistema, e cair em outro número abriria a conversa
 * errada sem sinal nenhum pro atendente.
 */

/** Só os campos que o deep-link usa — o access_token fica de fora de propósito. */
export type SupportConfig = {
  id: string;
  user_id: string;
  account_id: string;
  archived_at: string | null;
};

/** Motivo da falha. Vira log no servidor; a resposta HTTP não devolve o id. */
export type SupportFailure = "unconfigured" | "not_in_account" | "archived";

export class SupportConnectionError extends Error {
  constructor(readonly reason: SupportFailure) {
    super(`Support connection unavailable: ${reason}`);
    this.name = "SupportConnectionError";
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Id configurado, ou null quando ausente/malformado.
 *
 * A env é lida DENTRO da função, nunca no topo do módulo: no topo o valor
 * congela na carga do módulo e deixa de ser sobrescrevível em teste (mesmo
 * motivo documentado em lib/site-url.ts).
 */
export function getSupportConnectionId(): string | null {
  const raw = process.env.SUPPORT_CONNECTION_ID?.trim();
  return raw && UUID_RE.test(raw) ? raw : null;
}

/**
 * Conexão de Suporte da conta, ou erro tipado — nunca outra conexão.
 *
 * O `.eq('account_id')` mantém a invariante do módulo de conexões: config de uma
 * conta jamais é carregada por outra. O select é explícito para não trazer o
 * access_token cifrado a um caminho que não envia mensagem nenhuma.
 */
export async function resolveSupportConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<SupportConfig> {
  const id = getSupportConnectionId();
  if (!id) throw new SupportConnectionError("unconfigured");

  const { data } = await db
    .from("whatsapp_config")
    .select("id, user_id, account_id, archived_at")
    .eq("id", id)
    .eq("account_id", accountId)
    .maybeSingle();

  if (!data) throw new SupportConnectionError("not_in_account");

  // Conexão arquivada some do seletor de conexões e não envia: abrir conversa
  // nela deixaria o atendente numa thread muda.
  const config = data as SupportConfig;
  if (config.archived_at) throw new SupportConnectionError("archived");

  return config;
}
