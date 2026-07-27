"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Conversation } from "@/types";
import { useConversationWorkspace } from "@/hooks/use-conversation-workspace";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ConversationWorkspace } from "@/components/inbox/conversation-workspace";
import { useTranslation } from "react-i18next";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useActiveConnection } from "@/hooks/use-active-connection";
import {
  mergeKeepingActive,
  resolveDeepLink,
  shouldMergeIntoInboxList,
} from "@/lib/inbox/inbox-list-query";

export default function InboxPage() {
  const searchParams = useSearchParams();
  /** `?c=<id>` deep-link — abre o thread automaticamente ao chegar do dashboard. */
  const deepLinkConvId = searchParams.get("c");

  // A LISTA é específica do inbox (fila/abas via ConversationList). O MOTOR
  // (thread/sidebar/realtime/handlers) vive no useConversationWorkspace.
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);

  const { t } = useTranslation("inbox");
  const {
    connections,
    activeConnectionId,
    setActiveConnection,
    loading: connLoading,
  } = useActiveConnection();

  // Dispara o auto-select do deep-link exatamente uma vez por URL.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);
  // Dedupe de hidratação em voo (conv-INSERT e 1ª-msg-INSERT chamam juntas).
  // Map (não Set): guarda a PROMISE, pra chamadores concorrentes aguardarem o
  // mesmo fetch. Com Set, o segundo saía por `return` sem resultado nenhum — e
  // o deep-link, quase sempre o segundo, nunca conseguia selecionar a conversa.
  const hydratingConvIdsRef = useRef<Map<string, Promise<Conversation | null>>>(new Map());
  // Contexto do guard de merge, por ref: `ws` só existe mais abaixo, e pôr
  // favoritas/conexão nas deps recriaria o callback a cada toggle da estrela.
  const mergeCtxRef = useRef<{
    activeConnectionId: string | null;
    favoriteIds: ReadonlySet<string>;
  }>({ activeConnectionId: null, favoriteIds: new Set() });

  // Patcha uma linha da lista (impl do inbox p/ o hook agnóstico).
  const patchConversation = useCallback(
    (id: string, updater: (c: Conversation) => Conversation) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
    },
    [],
  );

  // Busca uma conversa por id COM o contato joined (o payload do realtime não
  // traz joins). Deduplicado pela promise — ver hydratingConvIdsRef acima.
  // O join é OBRIGATÓRIO: ws.select() alimenta o activeContact a partir de
  // conv.contact, e `contact` é opcional no tipo — perdê-lo deixaria a
  // ContactSidebar vazia sem estourar nada no tsc.
  const fetchConversationById = useCallback((convId: string): Promise<Conversation | null> => {
    const inFlight = hydratingConvIdsRef.current.get(convId);
    if (inFlight) return inFlight;
    const p = (async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contact:contacts(*)")
        .eq("id", convId)
        .maybeSingle();
      if (error) {
        console.error("Failed to hydrate conversation:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return null;
      }
      return (data as Conversation | null) ?? null;
    })().finally(() => {
      hydratingConvIdsRef.current.delete(convId);
    });
    hydratingConvIdsRef.current.set(convId, p);
    return p;
  }, []);

  // upsert do inbox: hidrata e mescla na lista. Self-heal p/ eventos perdidos.
  // O guard é necessário porque o canal do realtime assina SEM filtro nenhum
  // (use-realtime.ts): sem ele, conversa de outra conexão entraria na lista e
  // violaria o .eq("connection_id") da query.
  const hydrateConversation = useCallback(
    async (convId: string) => {
      const fetched = await fetchConversationById(convId);
      if (!fetched) return;
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Já está no estado — só faz backfill do `contact` (realtime não traz).
          return prev.map((c) =>
            c.id === fetched.id ? { ...c, contact: c.contact ?? fetched.contact } : c,
          );
        }
        if (!shouldMergeIntoInboxList(fetched, mergeCtxRef.current)) return prev;
        return [fetched, ...prev];
      });
    },
    [fetchConversationById],
  );

  // Motor compartilhado. onSelect/onClose = efeitos de página (deep-link + URL).
  const ws = useConversationWorkspace({
    channelName: "inbox-realtime",
    conversations,
    patchConversation,
    upsertConversation: hydrateConversation,
    onSelect: (conv) => {
      // Atualiza a URL (?c=) só p/ deep-link/reload — via history API, NÃO router.replace.
      // router.replace dispara navegação RSC que passa no middleware (getUser + refresh de
      // cookie); em refresh de token, o App Router degrada pra HARD RELOAD → a página
      // recarregava ao clicar na conversa ("às vezes"). history.replaceState só troca a
      // barra de endereço, sem navegar/remontar. O deep-link é lido no mount (searchParams).
      // NÃO tocar em autoSelectedForDeepLinkRef aqui: como a URL não re-dispara o
      // searchParams, deepLinkConvId fica fixo; o ref marca só CONSUMO do deep-link
      // (senão uma recarga da lista re-selecionaria a conversa do deep-link).
      window.history.replaceState(null, "", `/inbox?c=${conv.id}`);
    },
    onClose: () => {
      window.history.replaceState(null, "", "/inbox");
    },
  });

  // Banner de conexão do WhatsApp (específico do inbox).
  useEffect(() => {
    const checkConnection = async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) return;
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }
      const { data } = await supabase
        .from("whatsapp_config")
        .select("status")
        .eq("account_id", accountId)
        .eq("is_primary", true)
        .maybeSingle();
      setWhatsappConnected(data?.status === "connected");
    };
    checkConnection();
  }, []);

  // Mantém o ref do guard de merge em dia (lido pelo hydrateConversation).
  useEffect(() => {
    mergeCtxRef.current = { activeConnectionId, favoriteIds: ws.favorites };
  });

  // Callback da lista. A conversa ATIVA sobrevive ao refetch mesmo quando não
  // vem no conjunto retornado (deep-link além do teto, finalizada): sem isso
  // ela sumiria a cada visibilitychange — que bumpa o resyncToken — e, por
  // nunca entrar no knownConvIdsRef do workspace, cada mensagem nova dela
  // dispararia um SELECT redundante.
  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(mergeKeepingActive(loaded, ws.activeConversation));
    },
    [ws.activeConversation],
  );

  // Deep-link `?c=`: busca SEMPRE por id. Procurar na lista carregada falha
  // justamente no caso que motiva o link — conversa recém-criada, sem
  // last_message_at, no fim da ordenação e além do teto do PostgREST.
  useEffect(() => {
    const action = resolveDeepLink({
      deepLinkId: deepLinkConvId,
      consumedId: autoSelectedForDeepLinkRef.current,
      activeId: ws.activeConversation?.id ?? null,
    });
    if (action.kind === "none") return;
    // Marca ANTES do fetch: o effect pode re-rodar e dois fetches do mesmo id
    // seriam desperdício.
    autoSelectedForDeepLinkRef.current = action.id;

    let cancelled = false;
    (async () => {
      const conv = await fetchConversationById(action.id);
      if (cancelled) return;
      if (!conv) {
        // Id inexistente, apagado, ou de outra conta (a RLS conversations_select
        // devolve null, não erro). Limpa o ?c= órfão pra um reload não repetir.
        console.warn("Deep-link conversation not resolved:", action.id);
        toast.error(t("deepLinkNotFound"));
        window.history.replaceState(null, "", "/inbox");
        return;
      }
      // O usuário abriu outra conversa enquanto o fetch estava em voo: a
      // escolha dele vence.
      if (ws.activeConversation) return;
      setConversations((prev) => mergeKeepingActive(prev, conv));
      ws.select(conv);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- roda uma vez por
    // deep-link; `ws` troca de identidade a cada render do workspace e
    // re-dispararia o fetch. O consumo do ref já garante execução única.
  }, [deepLinkConvId]);

  // Reconcilia a conexão ativa com a da conversa aberta por deep-link: sem
  // isso a lista mostra o número A com a thread do B aberta, e a linha nunca
  // realça. Effect separado porque `connections` só chega DEPOIS do mount —
  // resolver isso dentro do effect acima falharia em silêncio no cold mount.
  const connReconciledRef = useRef<string | null>(null);
  useEffect(() => {
    const conv = ws.activeConversation;
    if (connLoading || !conv || !deepLinkConvId || conv.id !== deepLinkConvId) return;
    if (connReconciledRef.current === conv.id) return;
    if (!conv.connection_id || conv.connection_id === activeConnectionId) return;
    // Conexão arquivada (064) não está em `connections`: abre a thread e pronto.
    const target = connections.find((c) => c.id === conv.connection_id);
    if (!target) return;
    connReconciledRef.current = conv.id;
    setActiveConnection(target.id);
    // Toast obrigatório: a troca grava cookie de 1 ano e reparticiona Contatos,
    // Conversas, Broadcasts e Dashboard — não pode acontecer em silêncio.
    toast.info(t("switchedConnection", { label: target.label ?? target.phone_number_id }));
  }, [
    ws.activeConversation,
    connLoading,
    connections,
    activeConnectionId,
    setActiveConnection,
    deepLinkConvId,
    t,
  ]);

  // Mobile: ao abrir um thread, esconde o header global (CSS via data-attr).
  useEffect(() => {
    if (ws.hasActiveConv) {
      document.body.dataset.inboxThread = "open";
    } else {
      delete document.body.dataset.inboxThread;
    }
    return () => {
      delete document.body.dataset.inboxThread;
    };
  }, [ws.hasActiveConv]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Banner de WhatsApp desconectado — empurra os painéis pra baixo. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">{t("notConnected")}</p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: lista de conversas (fila/abas). Some no mobile com conversa aberta. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex-none",
            ws.hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
          <ConversationList
            activeConversationId={ws.activeConversation?.id ?? null}
            onSelect={ws.select}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={ws.resyncToken}
            onMarkUnread={ws.handleMarkUnread}
            favorites={ws.favorites}
            favoritesLoading={ws.favoritesLoading}
            onToggleFavorite={ws.handleToggleFavorite}
          />
        </div>

        {/* Right: motor da conversa (thread + sidebar + overlays), compartilhado. */}
        <ConversationWorkspace ws={ws} />
      </div>
    </div>
  );
}
