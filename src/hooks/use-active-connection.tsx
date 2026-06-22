"use client";

// ============================================================
// Conexão ATIVA no client (multi-número, 033). Espelha use-auth.tsx:
// Provider + contexto + hook. Lista as conexões da conta e mantém a
// "ativa" num cookie (por sessão) — o backend lê o mesmo cookie em
// getActiveConnection (lib/connections/active.ts).
//
// O cookie NÃO é httpOnly (o client precisa lê-lo); guarda só o UUID.
// A fronteira de segurança continua a conta (RLS) — a conexão é uma
// partição dentro dela; o backend revalida o ownership do cookie.
// ============================================================

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "./use-auth";

export const ACTIVE_CONNECTION_COOKIE = "active_connection_id";

export interface Connection {
  id: string;
  phone_number_id: string;
  status: "connected" | "disconnected";
  is_primary: boolean;
}

interface ActiveConnectionContextValue {
  connections: Connection[];
  activeConnectionId: string | null;
  activeConnection: Connection | null;
  /** Troca a conexão ativa: grava o cookie e atualiza o estado. */
  setActiveConnection: (id: string) => void;
  loading: boolean;
}

const ActiveConnectionContext = createContext<ActiveConnectionContextValue | null>(
  null,
);

// Lê o cookie de conexão ativa no client (ou null).
function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${ACTIVE_CONNECTION_COOKIE}=([^;]*)`),
  );
  return match ? decodeURIComponent(match[1]) : null;
}

// Grava o cookie de conexão ativa (SameSite=Lax, Secure em https, 1 ano).
function writeCookie(id: string): void {
  if (typeof document === "undefined") return;
  const secure = location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${ACTIVE_CONNECTION_COOKIE}=${encodeURIComponent(id)}; path=/; max-age=31536000; samesite=lax${secure}`;
}

export function ActiveConnectionProvider({ children }: { children: ReactNode }) {
  const { accountId } = useAuth();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  // Carrega as conexões da conta (RLS já confina à conta do usuário).
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("whatsapp_config")
        .select("id, phone_number_id, status, is_primary")
        .eq("account_id", accountId);
      if (cancelled) return;
      const list = (data ?? []) as Connection[];
      setConnections(list);
      // Conexão ativa = cookie (se ainda existir na lista) → primária → 1ª.
      const fromCookie = readCookie();
      const valid = fromCookie && list.some((c) => c.id === fromCookie);
      const primary = list.find((c) => c.is_primary);
      setActiveConnectionId(
        valid ? fromCookie : (primary?.id ?? list[0]?.id ?? null),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const setActiveConnection = useCallback((id: string) => {
    writeCookie(id);
    setActiveConnectionId(id);
  }, []);

  const value = useMemo<ActiveConnectionContextValue>(() => {
    const activeConnection =
      connections.find((c) => c.id === activeConnectionId) ?? null;
    return {
      connections,
      activeConnectionId,
      activeConnection,
      setActiveConnection,
      loading,
    };
  }, [connections, activeConnectionId, setActiveConnection, loading]);

  return (
    <ActiveConnectionContext.Provider value={value}>
      {children}
    </ActiveConnectionContext.Provider>
  );
}

/**
 * Acessa a conexão ativa. Fora do provider, devolve um fallback vazio
 * (mesma postura "least-surprise" de useAuth) para não quebrar telas
 * que ainda não foram envolvidas pelo provider durante o rollout.
 */
export function useActiveConnection(): ActiveConnectionContextValue {
  const ctx = useContext(ActiveConnectionContext);
  if (ctx) return ctx;
  return {
    connections: [],
    activeConnectionId: null,
    activeConnection: null,
    setActiveConnection: () => {},
    loading: false,
  };
}
