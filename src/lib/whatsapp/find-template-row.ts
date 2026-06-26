// ============================================================
// Lookup do template de ENVIO, escopado à CONEXÃO (multi-número, 033).
//
// Sem o filtro de connection_id, duas conexões com template de mesmo
// name+language fazem o .maybeSingle() estourar (multiple rows → erro,
// possível 500 no envio). Espelha o lookup de src/lib/broadcast/
// send-engine.ts:111-120.
//
// Retorna a linha CRUA (sem validar o shape): cada caller decide o que
// fazer com row malformada — a rota interativa devolve 500 "rode Sync",
// o cron apenas trata como nula.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

export async function findTemplateRow(
  db: SupabaseClient,
  args: {
    accountId: string;
    connectionId?: string | null;
    name: string;
    language: string;
  },
): Promise<Record<string, unknown> | null> {
  let q = db
    .from("message_templates")
    .select("*")
    .eq("account_id", args.accountId)
    .eq("name", args.name)
    .eq("language", args.language);
  // Filtra pela conexão quando conhecida — evita casar o template de
  // mesmo nome de OUTRA conexão (e o erro multiple-rows do maybeSingle).
  if (args.connectionId) q = q.eq("connection_id", args.connectionId);
  const { data } = await q.maybeSingle();
  return (data as Record<string, unknown> | null) ?? null;
}
