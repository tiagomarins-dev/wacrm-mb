"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { useRealtime } from "@/hooks/use-realtime";
import { useAuth } from "@/hooks/use-auth";
import type { Conversation, Message, Contact } from "@/types";

// Chave device-scoped do estado do painel de contato no desktop (espelha o inbox).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

// ============================================================
// Motor da conversa (thread + sidebar + realtime + handlers) compartilhado por
// /inbox e /conversations. É AGNÓSTICO À LISTA: quem consome injeta a lista
// (`conversations`) + callbacks de patch (`patchConversation`/`upsertConversation`),
// para cada página aplicar contra a sua fonte (inbox=state próprio; /conversations=
// rows da RPC). `channelName` e `onClose`/`onSelect` são parametrizados para não
// colidir no canal realtime nem acoplar URL. Extração fiel de inbox/page.tsx.
// ============================================================
export interface UseConversationWorkspaceArgs {
  /** Nome do canal realtime — DISTINTO por rota ("inbox-realtime" / "conversations-realtime"). */
  channelName: string;
  /** Lista atual (dona: a página). Usada só p/ derivar os ids conhecidos. */
  conversations: Conversation[];
  /** Patcha uma linha existente da lista (updater recebe a linha atual). */
  patchConversation: (id: string, updater: (c: Conversation) => Conversation) => void;
  /** Conv desconhecida (fora da lista): inbox hidrata+prepend; /conversations = noop. */
  upsertConversation: (convId: string) => void;
  /** Efeito de página após selecionar (inbox: grava ref + router.replace). */
  onSelect?: (conv: Conversation) => void;
  /** Efeito de página ao fechar (inbox: router.replace("/inbox")). */
  onClose?: () => void;
}

export function useConversationWorkspace({
  channelName,
  conversations,
  patchConversation,
  upsertConversation,
  onSelect,
  onClose,
}: UseConversationWorkspaceArgs) {
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  // Bumped p/ forçar refetch dos filhos (rede de segurança contra eventos perdidos).
  const [resyncToken, setResyncToken] = useState(0);
  // Painel de contato no desktop (default true; restaurado do localStorage pós-mount).
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  // Detalhes do contato em tela cheia no mobile (3ª "tela").
  const [contactMobileOpen, setContactMobileOpen] = useState(false);
  // Painel destacado num modal full-screen (desktop). Um por vez.
  const [expanded, setExpanded] = useState<"thread" | "contact" | null>(null);
  // Favoritos do usuário (076) — ids de conversa pinados na aba "Minhas".
  const { user, accountId } = useAuth();
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage pode lançar em contexto sandbox/privado.
    }
  }, []);

  // A11y: Esc fecha o overlay de contato (mobile).
  useEffect(() => {
    if (!contactMobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setContactMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [contactMobileOpen]);

  // A11y: Esc fecha o painel destacado (desktop).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // best-effort.
      }
      return next;
    });
  }, []);

  // Espelho síncrono dos ids da lista — os handlers de realtime precisam saber
  // "já temos esta conv?" sem esperar o updater do setState (ver inbox #105/#106).
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Realtime: mensagens. INSERT → adiciona ao thread ativo + patcha o preview da
  // lista (ou upsert se conv desconhecida). UPDATE → só atualiza status da msg do
  // thread aberto (guard evita auto-scroll por atividade de outra conversa).
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      if (event.eventType === "INSERT") {
        if (activeConversation && newMsg.conversation_id === activeConversation.id) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === newMsg.id)) return prev;
            const withoutOptimistic = prev.filter((m) => !m.id.startsWith("temp-"));
            return [...withoutOptimistic, newMsg];
          });
        }

        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          patchConversation(newMsg.conversation_id, (c) => ({
            ...c,
            last_message_text: newMsg.content_text ?? "",
            last_message_at: newMsg.created_at,
            last_message_sender_type: newMsg.sender_type,
            unread_count:
              activeConversation?.id === newMsg.conversation_id
                ? 0
                : c.unread_count + 1,
          }));
        } else {
          upsertConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === "UPDATE") {
        setMessages((prev) => {
          if (!prev.some((m) => m.id === newMsg.id)) return prev;
          return prev.map((m) => (m.id === newMsg.id ? { ...m, ...newMsg } : m));
        });
      }
    },
    [activeConversation, patchConversation, upsertConversation],
  );

  // Realtime: conversas. INSERT → upsert (hidrata p/ trazer o contato). UPDATE →
  // patcha a linha (suprime unread flicker se é a ativa) + atualiza a ativa.
  const handleConversationEvent = useCallback(
    (event: { eventType: string; new: Conversation; old: Partial<Conversation> }) => {
      const conv = event.new;

      if (event.eventType === "INSERT") {
        if (!knownConvIdsRef.current.has(conv.id)) {
          upsertConversation(conv.id);
        }
      }

      if (event.eventType === "UPDATE") {
        if (knownConvIdsRef.current.has(conv.id)) {
          const isActive = activeConversation?.id === conv.id;
          patchConversation(conv.id, (c) => ({
            ...c,
            ...conv,
            unread_count: isActive ? 0 : conv.unread_count,
          }));
        } else {
          upsertConversation(conv.id);
        }

        if (activeConversation && conv.id === activeConversation.id) {
          setActiveConversation((prev) => (prev ? { ...prev, ...conv } : prev));
        }
      }
    },
    [activeConversation, patchConversation, upsertConversation],
  );

  const { isConnected } = useRealtime({
    channelName,
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  // Resync no reconnect (false→true depois do connect inicial).
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      if (initialConnectDoneRef.current) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  // Resync ao reganhar foco da aba (WS pode ter sido throttled).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setResyncToken((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  // Seleciona a conversa: seta ativa/contato, limpa msgs, reset otimista do unread
  // na lista, e dispara o efeito de página (onSelect — inbox faz ref+router.replace).
  const select = useCallback(
    (conv: Conversation) => {
      if (activeConversation?.id === conv.id) return;
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      patchConversation(conv.id, (c) =>
        c.unread_count > 0 ? { ...c, unread_count: 0 } : c,
      );
      onSelect?.(conv);
    },
    [activeConversation?.id, patchConversation, onSelect],
  );

  // Fecha a conversa: limpa estado + overlay mobile + efeito de página (onClose).
  const close = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    setContactMobileOpen(false);
    onClose?.();
  }, [onClose]);

  // Carrega os favoritos do usuário (076). resyncToken nas deps = rede de
  // segurança cross-device (reconnect/visibility recarregam).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!user?.id) {
        if (!cancelled) setFavorites(new Set());
        return;
      }
      const supabase = createClient();
      const { data, error } = await supabase
        .from("conversation_favorites")
        .select("conversation_id")
        .eq("user_id", user.id);
      if (cancelled) return;
      if (error) {
        // Supabase errors têm props não-enumeráveis — logar campos explícitos.
        console.error("Failed to fetch conversation favorites:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      setFavorites(new Set((data ?? []).map((r) => r.conversation_id as string)));
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, resyncToken]);

  // Favorita/desfavorita (076) — otimista com rollback. Guard de accountId:
  // o profile pode ainda não ter carregado (use-auth derived) e o insert
  // violaria NOT NULL.
  const handleToggleFavorite = useCallback(
    async (id: string) => {
      if (!user?.id || !accountId) return;
      const snapshot = favorites;
      const wasFavorite = favorites.has(id);
      const next = new Set(favorites);
      if (wasFavorite) next.delete(id);
      else next.add(id);
      setFavorites(next);

      const supabase = createClient();
      const { error } = wasFavorite
        ? await supabase
            .from("conversation_favorites")
            .delete()
            .match({ conversation_id: id, user_id: user.id })
        : await supabase
            .from("conversation_favorites")
            .upsert(
              { account_id: accountId, conversation_id: id, user_id: user.id },
              { onConflict: "user_id,conversation_id", ignoreDuplicates: true },
            );
      if (error) {
        toast.error("Falha ao atualizar favorito");
        setFavorites(snapshot);
      }
    },
    [user?.id, accountId, favorites],
  );

  // Marca a conversa como não lida (unread_count=1) + rollback local no erro.
  const handleMarkUnread = useCallback(
    async (id: string) => {
      patchConversation(id, (c) => ({ ...c, unread_count: 1 }));
      const supabase = createClient();
      const { error } = await supabase
        .from("conversations")
        .update({ unread_count: 1 })
        .eq("id", id);
      if (error) {
        toast.error("Falha ao marcar como não lida");
        patchConversation(id, (c) => ({ ...c, unread_count: 0 }));
      }
    },
    [patchConversation],
  );

  // Do header do thread: fecha antes de marcar (senão o auto-reset do thread zera).
  const handleMarkUnreadFromThread = useCallback(
    (id: string) => {
      close();
      handleMarkUnread(id);
    },
    [close, handleMarkUnread],
  );

  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    setMessages(loaded);
  }, []);

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleUpdateMessage = useCallback((id: string, updates: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)));
  }, []);

  const handleStatusChange = useCallback(
    (conversationId: string, status: string) => {
      patchConversation(conversationId, (c) => ({ ...c, status }));
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, status } : prev));
      }
    },
    [activeConversation?.id, patchConversation],
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      patchConversation(conversationId, (c) => ({
        ...c,
        assigned_agent_id: assignedAgentId ?? undefined,
      }));
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) =>
          prev ? { ...prev, assigned_agent_id: assignedAgentId ?? undefined } : prev,
        );
      }
    },
    [activeConversation?.id, patchConversation],
  );

  const hasActiveConv = !!activeConversation;

  // Props prontas do MessageThread — mesma lista de props do inbox (renderThread).
  const threadProps = {
    conversation: activeConversation,
    contact: activeContact,
    messages,
    onMessagesLoaded: handleMessagesLoaded,
    onNewMessage: handleNewMessage,
    onUpdateMessage: handleUpdateMessage,
    onStatusChange: handleStatusChange,
    onAssignChange: handleAssignChange,
    onBack: close,
    onMarkUnread: handleMarkUnreadFromThread,
    isFavorite: activeConversation ? favorites.has(activeConversation.id) : false,
    onToggleFavorite: handleToggleFavorite,
    resyncToken,
    onRefresh: handleManualRefresh,
    contactPanelOpen,
    onToggleContactPanel: handleToggleContactPanel,
    onOpenContact: () => setContactMobileOpen(true),
    expanded: expanded === "thread",
    onToggleExpand: () => setExpanded((e) => (e === "thread" ? null : "thread")),
  };

  // Props do ContactSidebar (desktop). O onContactUpdate reflete a edição inline.
  const sidebarProps = {
    contact: activeContact,
    onContactUpdate: (p: Partial<Contact>) =>
      setActiveContact((prev) => (prev ? { ...prev, ...p } : prev)),
  };

  return {
    // estado
    activeConversation,
    activeContact,
    setActiveContact,
    messages,
    resyncToken,
    contactPanelOpen,
    contactMobileOpen,
    setContactMobileOpen,
    expanded,
    setExpanded,
    hasActiveConv,
    // ações
    select,
    close,
    handleMarkUnread,
    favorites,
    handleToggleFavorite,
    // props montadas
    threadProps,
    sidebarProps,
  };
}
