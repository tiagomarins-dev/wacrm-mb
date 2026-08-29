import type { SupabaseClient } from "@supabase/supabase-js";
import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";

/**
 * Resolução de contato a partir do telefone que chega no deep-link externo.
 *
 * Espelha `findOrCreateContact` (whatsapp/inbound.ts) — mesmo dedupe, mesmo
 * backstop de corrida — com uma divergência deliberada, documentada em
 * `findOrCreateContactByPhone`.
 */

/**
 * Telefone do deep-link em dígitos com DDI, ou null.
 *
 * 10 e 11 dígitos SEMPRE ganham o 55, mesmo quando já começam com 55: `55`
 * também é o DDD de Santa Maria/RS, então `5521999999` é um número local sem
 * DDI e precisa virar `555521999999`. Manter deixaria o número sem país e a
 * busca casaria o contato errado.
 */
export function normalizeDeepLinkPhone(raw: unknown): string | null {
  const digits = typeof raw === "string" ? raw.replace(/\D/g, "") : "";
  if (digits.length < 10 || digits.length > 15) return null;
  return digits.length <= 11 ? `55${digits}` : digits;
}

/** Teto do nome: cabe em qualquer lista da UI e não vira payload. */
export const MAX_CONTACT_NAME = 80;

// Caractere de controle vindo da query string não pode chegar ao banco.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

/**
 * Nome exibível a partir de entrada não confiável (query string).
 * Sem nome utilizável, usa o próprio telefone — mesmo fallback do inbound.
 */
export function sanitizeContactName(
  raw: unknown,
  fallbackPhone: string,
): string {
  if (typeof raw !== "string") return fallbackPhone;
  const limpo = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  return limpo ? limpo.slice(0, MAX_CONTACT_NAME) : fallbackPhone;
}

export interface ContactByPhoneOutcome {
  contact: { id: string };
  wasCreated: boolean;
}

/**
 * Acha (dedupe por conexão) ou cria o contato do deep-link.
 *
 * Divergência deliberada de `findOrCreateContact` (whatsapp/inbound.ts): aqui o
 * contato que já existe é usado COMO ESTÁ, sem atualizar o nome. No inbound o
 * nome vem do push-name do dono do número — é o próprio contato se
 * identificando. Aqui vem de query string, e atualizar deixaria um link forjado
 * renomear contatos reais, um por clique.
 */
export async function findOrCreateContactByPhone(
  db: SupabaseClient,
  accountId: string,
  ownerUserId: string,
  connectionId: string,
  phone: string,
  name: string,
): Promise<ContactByPhoneOutcome | null> {
  const existing = await findExistingContact(db, accountId, phone, connectionId);
  if (existing) return { contact: { id: existing.id }, wasCreated: false };

  const { data, error } = await db
    .from("contacts")
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      connection_id: connectionId,
      phone,
      name,
    })
    .select("id")
    .single();

  if (error) {
    // Corrida: outra requisição criou o mesmo número entre o find e o insert.
    // O índice único por (conta, conexão, telefone) garante que só uma passou.
    if (isUniqueViolation(error)) {
      const raced = await findExistingContact(
        db,
        accountId,
        phone,
        connectionId,
      );
      if (raced) return { contact: { id: raced.id }, wasCreated: false };
    }
    console.error("[open-by-phone] falha ao criar contato:", error);
    return null;
  }

  return { contact: { id: (data as { id: string }).id }, wasCreated: true };
}
