// ============================================================
// Resolução server-side da CONEXÃO ATIVA (multi-número, 033).
//
// Espelha o padrão de `lib/auth/account.ts` (getCurrentAccount):
// módulo server-only — importa `next/headers` (cookies). Importar de
// um client component falha no build (a checagem de boundary do Next).
//
// O cookie `active_connection_id` é client-writable → NUNCA confiar no
// valor sem validar (a) formato UUID e (b) ownership: a conexão tem de
// pertencer à conta do caller. `access_token` é o ativo mais sensível
// do sistema, então todo load de whatsapp_config por id carrega junto
// `.eq('account_id', accountId)` (não vazar token entre contas).
// ============================================================

import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";

export const ACTIVE_CONNECTION_COOKIE = "active_connection_id";

// UUID v4-ish. Serve só para rejeitar lixo antes de tocar o banco —
// um valor malformado vira fallback silencioso, nunca um erro exposto.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Forma mínima da conexão que o app precisa para operar/enviar. */
export interface ActiveConnection {
  id: string;
  phone_number_id: string;
  is_primary: boolean;
}

/**
 * Resolve a conexão ativa do caller:
 *   1. cookie com UUID válido E pertencente à conta → usa-o;
 *   2. senão, fallback para a conexão primária da conta;
 *   3. conta sem nenhuma conexão → lança (erro de configuração).
 *
 * Recebe o `db` já RLS-scoped e o `accountId` resolvidos por
 * `getCurrentAccount`/`requireRole` (lib/auth/account.ts).
 */
export async function getActiveConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<ActiveConnection> {
  const cookieStore = await cookies();
  const cookieVal = cookieStore.get(ACTIVE_CONNECTION_COOKIE)?.value ?? null;

  // (1) cookie válido e da própria conta. O `.eq('account_id')` é o
  // controle de ownership — um id de conexão de outra conta não casa.
  if (cookieVal && UUID_RE.test(cookieVal)) {
    const { data } = await db
      .from("whatsapp_config")
      .select("id, phone_number_id, is_primary")
      .eq("id", cookieVal)
      .eq("account_id", accountId)
      .maybeSingle();
    if (data) return data as ActiveConnection;
  }

  // (2) fallback: conexão primária da conta (cookie ausente/inválido/de outra conta).
  const { data: primary } = await db
    .from("whatsapp_config")
    .select("id, phone_number_id, is_primary")
    .eq("account_id", accountId)
    .eq("is_primary", true)
    .maybeSingle();
  if (primary) return primary as ActiveConnection;

  // (3) conta sem conexão configurada.
  throw new Error("Nenhuma conexão WhatsApp configurada para esta conta");
}
