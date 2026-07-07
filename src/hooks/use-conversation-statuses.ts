"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { mergeStatuses } from "@/lib/inbox/conversation-statuses";
import type { ConversationStatusRow } from "@/types";

// ============================================================
// Carrega os status da conta 1× e devolve a lista resolvida (system+custom,
// com fallback embutido) + índice por key. Usar no nível de page e repassar
// aos filhos (lista, thread, filtro) — evita N fetches por linha.
// ============================================================
export function useConversationStatuses() {
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();
  const [rows, setRows] = useState<ConversationStatusRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    if (!accountId) {
      setLoading(false);
      return;
    }
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("conversation_statuses")
        .select("*")
        .eq("account_id", accountId)
        .order("sort_order", { ascending: true });
      if (!active) return;
      setRows(data ?? []);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accountId]);

  // mergeStatuses aplica os defaults de sistema por cima do que veio do banco.
  const statuses = useMemo(() => mergeStatuses(rows), [rows]);
  const byKey = useMemo(
    () => new Map(statuses.map((s) => [s.key, s])),
    [statuses],
  );

  return { statuses, byKey, loading };
}
