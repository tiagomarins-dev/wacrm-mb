// ============================================================
// Resolvers de CONEXÃO DE ENVIO (outbound) — puros, sem next/headers.
//
// Diferente de `active.ts` (que lê o cookie e é server-request-only),
// este módulo só consulta o banco, então pode ser usado em qualquer
// contexto — inclusive engines/cron com client service-role
// (flows, automations, broadcast-cron).
//
// Invariante de segurança (H1): todo load de whatsapp_config por id
// carrega junto `.eq('account_id', accountId)`. O `access_token` é o
// ativo mais sensível do sistema — um connection_id de outra conta
// NUNCA pode carregar o token alheio. Se o id não casa a conta, cai
// na conexão primária da própria conta (nunca na outra).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import type { WhatsAppConfig } from "@/types";

/**
 * Resolve a whatsapp_config de ENVIO da conta.
 *
 * `connectionId` deve vir do DADO DO BANCO (conversa/broadcast/run),
 * nunca do cookie ativo (H2): um agente com a conexão B ativa que
 * responde uma conversa da conexão A precisa enviar pela A.
 *
 * Fallback de rollout: se `connectionId` for nulo (linha criada antes
 * do create-path ser threado) ou não pertencer à conta, usa a conexão
 * primária — assim o envio nunca quebra durante o rollout em estágios.
 *
 * Retorno frouxo (Record) de propósito: os senders fazem
 * `decrypt(config.access_token)` e leem `config.phone_number_id`.
 */
export async function resolveOutboundConfig(
  db: SupabaseClient,
  accountId: string,
  connectionId?: string | null,
): Promise<WhatsAppConfig> {
  // (1) connection_id da linha, escopado à conta (H1).
  if (connectionId) {
    const { data } = await db
      .from("whatsapp_config")
      .select("*")
      .eq("id", connectionId)
      .eq("account_id", accountId)
      .maybeSingle();
    if (data) return data as WhatsAppConfig;
  }

  // (2) fallback: conexão primária da conta.
  const { data: primary } = await db
    .from("whatsapp_config")
    .select("*")
    .eq("account_id", accountId)
    .eq("is_primary", true)
    .maybeSingle();
  if (primary) return primary as WhatsAppConfig;

  throw new Error("Nenhuma conexão WhatsApp disponível para envio nesta conta");
}

/**
 * Conveniência para os senders que têm um `conversationId` em mãos
 * (flows, automations): deriva o connection_id da conversa e resolve a
 * config de envio. A conversa é a fonte da verdade de "qual número
 * responder" (H2).
 */
export async function resolveOutboundConfigForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<WhatsAppConfig> {
  const { data: conv } = await db
    .from("conversations")
    .select("connection_id")
    .eq("id", conversationId)
    .eq("account_id", accountId)
    .maybeSingle();
  const connectionId = (conv as { connection_id?: string | null } | null)
    ?.connection_id;
  return resolveOutboundConfig(db, accountId, connectionId ?? undefined);
}
