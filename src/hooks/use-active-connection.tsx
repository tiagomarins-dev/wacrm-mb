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
import { pickActiveConnectionId } from "@/lib/connections/pick-active";
import { useAuth } from "./use-auth";

export const ACTIVE_CONNECTION_COOKIE = "active_connection_id";

export interface Connection {
  id: string;
  phone_number_id: string;
  status: "connected" | "disconnected";
  is_primary: boolean;
  // Apelido (055) — rótulo de exibição preferido no dropdown (fallback no phone).
  label?: string | null;
}

export const CONNECTIONS_CHANGED_EVENT = "wacrm:connections-changed";

interface ActiveConnectionContextValue {
  connections: Connection[];
  activeConnectionId: string | null;
  activeConnection: Connection | null;
  /** Troca a conexão ativa: grava o cookie e atualiza o estado. */
  setActiveConnection: (id: string) => void;
  /** Re-busca a lista de conexões da conta (ex.: após conectar um número). */
  refresh: () => void;
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
  // Reutilizável: chamado no mount e quando uma conexão é criada/alterada
  // (evento CONNECTIONS_CHANGED_EVENT, disparado pela tela de Settings).
  const refresh = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data } = await supabase
      .from("whatsapp_config")
      .select("id, phone_number_id, status, is_primary, label")
      .eq("account_id", accountId);
    const list = (data ?? []) as Connection[];
    setConnections(list);
    // Conexão ativa: cookie → atual → primária → 1ª (lógica pura em pick-active).
    setActiveConnectionId((prev) =>
      pickActiveConnectionId(list, readCookie(), prev),
    );
    setLoading(false);
  }, [accountId]);

  useEffect(() => {
    // refresh() só faz setState DEPOIS do await (não-síncrono) — o aviso de
    // cascading render não se aplica.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Re-busca quando a tela de Settings conecta/remove um número, para o
  // dropdown aparecer/atualizar SEM precisar recarregar a página.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => void refresh();
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, handler);
    return () => window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handler);
  }, [refresh]);

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
      refresh: () => void refresh(),
      loading,
    };
  }, [connections, activeConnectionId, setActiveConnection, refresh, loading]);

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
    refresh: () => {},
    loading: false,
  };
}
