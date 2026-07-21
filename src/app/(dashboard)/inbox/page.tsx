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

export default function InboxPage() {
  const searchParams = useSearchParams();
  /** `?c=<id>` deep-link — abre o thread automaticamente ao chegar do dashboard. */
  const deepLinkConvId = searchParams.get("c");

  // A LISTA é específica do inbox (fila/abas via ConversationList). O MOTOR
  // (thread/sidebar/realtime/handlers) vive no useConversationWorkspace.
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);

  const { t } = useTranslation("inbox");

  // Dispara o auto-select do deep-link exatamente uma vez por URL.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);
  // Dedupe de hidratação em voo (conv-INSERT e 1ª-msg-INSERT chamam juntas).
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  // Patcha uma linha da lista (impl do inbox p/ o hook agnóstico).
  const patchConversation = useCallback(
    (id: string, updater: (c: Conversation) => Conversation) => {
      setConversations((prev) => prev.map((c) => (c.id === id ? updater(c) : c)));
    },
    [],
  );

  // upsert do inbox: busca a conversa com o contato joined e mescla na lista
  // (payload realtime não traz joins). Self-heal p/ eventos perdidos. Dedupe.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
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
        return;
      }
      if (!data) return;
      const fetched = data as Conversation;
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Já está no estado — só faz backfill do `contact` (realtime não traz).
          return prev.map((c) =>
            c.id === fetched.id ? { ...c, contact: c.contact ?? fetched.contact } : c,
          );
        }
        return [fetched, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, []);

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

  // Callback da lista: seta as conversas e resolve o deep-link (uma vez por URL).
  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(loaded);
      if (
        deepLinkConvId &&
        autoSelectedForDeepLinkRef.current !== deepLinkConvId &&
        loaded.length > 0
      ) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;
        if (ws.activeConversation?.id === deepLinkConvId) return;
        const match = loaded.find((c) => c.id === deepLinkConvId);
        if (match) ws.select(match);
      }
    },
    [deepLinkConvId, ws],
  );

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
            onToggleFavorite={ws.handleToggleFavorite}
          />
        </div>

        {/* Right: motor da conversa (thread + sidebar + overlays), compartilhado. */}
        <ConversationWorkspace ws={ws} />
      </div>
    </div>
  );
}
