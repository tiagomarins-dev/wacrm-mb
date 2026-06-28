"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus } from "@/types";
import { Search, ArrowDown, ArrowUp, Users } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
// Locale pt-BR do date-fns p/ traduzir os tempos relativos ("há 5 minutos").
import { ptBR } from "date-fns/locale";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { useAuth } from "@/hooks/use-auth";
import { classifyTab, sortByTab, countByTab, effectiveDir, type QueueTab } from "@/lib/inbox/queue";
import { conversationTitle } from "@/lib/inbox/conversation-title";
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";
import { useTranslation } from "react-i18next";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

// Direção do ordenador por tempo (toggle global das abas) + chave de persistência.
type SortDir = "asc" | "desc";
const SORT_DIR_KEY = "wacrm:inbox:sort-dir";

// Abas da fila de atendimento → chave i18n do label / do empty state.
const TAB_LABEL: Record<QueueTab, string> = {
  fila: "tabFila",
  minhas: "tabMinhas",
  sla: "tabSla",
  ia: "tabIa",
  geral: "tabGeral",
};
const EMPTY_KEY: Record<QueueTab, string> = {
  fila: "emptyFila",
  minhas: "emptyMinhas",
  sla: "emptySla",
  ia: "emptyIa",
  geral: "emptyGeral",
};
// "geral" saiu pra tela própria /conversations (paginada); "ia" só aparece p/
// admin/owner (montado dinamicamente no componente — ver `tabs`). TAB_LABEL/
// EMPTY_KEY mantêm todas as chaves por serem Record<QueueTab>.

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const { t } = useTranslation("inbox");
  const { user, canManageMembers, accountId } = useAuth();
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<QueueTab>("fila");
  const [loading, setLoading] = useState(true);
  // Ids tidos como "IA" p/ a aba Agente IA: bot genérico + perfis de IA da conta.
  // Base sempre tem o bot; perfis entram via fetch admin (effect abaixo).
  const [aiAgentIds, setAiAgentIds] = useState<ReadonlySet<string>>(
    () => new Set([AI_AGENT_USER_ID])
  );
  // Conexão ativa (multi-número, 033): só as conversas desta conexão.
  const { activeConnectionId } = useActiveConnection();
  // Ticker p/ a aba SLA "virar" sozinha (sem msg/evento): recomputa a cada 30s.
  // Sem isso, Date.now() ficaria congelado no useMemo e a conversa nunca entraria
  // no SLA depois de 30min parada.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Direção da ordenação por tempo. null = usa o default da aba (Fila/SLA asc,
  // resto desc). Default FIXO no initializer (NÃO ler localStorage aqui: o inbox
  // passa por SSR e leitura síncrona daria hydration mismatch — ver inbox/page.tsx).
  const [sortDir, setSortDir] = useState<SortDir | null>(null);
  // Restaura a direção salva DEPOIS do mount (reconcilia sem hydration mismatch).
  useEffect(() => {
    try {
      const v = localStorage.getItem(SORT_DIR_KEY);
      // Hidratação pós-mount (intencional): reconcilia ao valor salvo após o SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (v === "asc" || v === "desc") setSortDir(v);
    } catch {
      // localStorage pode lançar em private browsing/sandbox.
    }
  }, []);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      let q = supabase
        .from("conversations")
        .select("*, contact:contacts(*)")
        // nullsFirst:false — conversas sem mensagem (last_message_at null,
        // ex: criadas por evento de reação) afundam pro fim da lista em vez
        // de fixar no topo (default do DESC no Postgres é NULLS FIRST).
        .order("last_message_at", { ascending: false, nullsFirst: false });
      // Multi-número (033): filtra pela conexão ativa.
      if (activeConnectionId) q = q.eq("connection_id", activeConnectionId);
      const { data, error } = await q;

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(data ?? []);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken, activeConnectionId]);

  // Carrega os ids dos perfis de IA da conta p/ classificar a aba "Agente IA".
  // Só admin/owner (canManageMembers) — a base table ai_profiles é admin-only
  // (RLS migration 040). resyncToken nas deps refaz no reconnect/visibility;
  // .eq(account_id) é defense-in-depth além da RLS (espelha dispatch.ts).
  useEffect(() => {
    let cancelled = false;

    // setState fica dentro do IIFE async (nunca síncrono no corpo do effect, p/
    // não disparar render em cascata — regra react-hooks/set-state-in-effect).
    (async () => {
      // Sem permissão/conta: set base só com o bot (sem fetch).
      if (!canManageMembers || !accountId) {
        if (!cancelled) setAiAgentIds(new Set([AI_AGENT_USER_ID]));
        return;
      }

      const supabase = createClient();
      const { data, error } = await supabase
        .from("ai_profiles")
        .select("id")
        .eq("account_id", accountId);

      if (cancelled) return;

      if (error) {
        // Supabase errors têm props não-enumeráveis — logar campos explícitos.
        console.error("Failed to fetch ai_profiles ids:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return; // mantém o Set base (só o bot)
      }

      const ids = (data ?? []).map((r) => (r as { id: string }).id);
      setAiAgentIds(new Set([AI_AGENT_USER_ID, ...ids]));
    })();

    return () => {
      cancelled = true;
    };
  }, [canManageMembers, accountId, resyncToken]);

  // Abas visíveis: "Agente IA" só p/ admin/owner (canManageMembers), espelhando
  // o gate das configs de IA (ai_profiles é admin+).
  const tabs = useMemo<QueueTab[]>(
    () => ["fila", "minhas", "sla", ...(canManageMembers ? ["ia" as const] : [])],
    [canManageMembers]
  );

  // Aba efetivamente exibida: se o activeTab não está em `tabs` (ex.: era "ia" e
  // a permissão caiu), cai pra "fila" — sem setState (evita aba órfã/empty
  // fantasma de forma derivada, não imperativa).
  const effectiveTab = tabs.includes(activeTab) ? activeTab : "fila";

  const filtered = useMemo(() => {
    // Classifica pela aba ativa (fila/minhas/sla/ia/geral), aplica a busca e ordena.
    let result = conversations.filter((c) =>
      classifyTab(c, effectiveTab, user?.id, now, aiAgentIds)
    );

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    // sortDir (override do usuário) vence; null = default por aba.
    return sortByTab(result, effectiveTab, sortDir ?? undefined);
  }, [conversations, effectiveTab, search, now, user?.id, aiAgentIds, sortDir]);

  // Contadores de cada aba (badges em todas).
  const counts = useMemo(
    () => countByTab(conversations, user?.id, now, aiAgentIds),
    [conversations, user?.id, now, aiAgentIds]
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  // Inverte a direção a partir da efetiva da aba atual e persiste (best-effort,
  // inline no handler — espelha inbox/page.tsx). Vale globalmente (todas as abas).
  const handleToggleSort = useCallback(() => {
    const next: SortDir = effectiveDir(effectiveTab, sortDir) === "asc" ? "desc" : "asc";
    setSortDir(next);
    try {
      localStorage.setItem(SORT_DIR_KEY, next);
    } catch {
      // persistência best-effort.
    }
  }, [effectiveTab, sortDir]);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('searchConversations')}
            className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
          />
        </div>

        {/* Abas + ordenador. Abas: Fila / Minhas / SLA / Agente IA (admin+), cada uma
            com badge. O botão à direita inverte a ordem por tempo (vale em todas). */}
        <div className="flex items-center gap-1">
          <Tabs
            value={effectiveTab}
            onValueChange={(v) => setActiveTab(v as QueueTab)}
            className="min-w-0 flex-1"
          >
            <TabsList variant="line" className="w-full justify-start gap-1 overflow-x-auto">
              {tabs.map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab}
                  title={tab === "sla" ? t("slaTooltip") : undefined}
                  className="shrink-0 grow-0 gap-1.5 px-2 text-xs"
                >
                  {t(TAB_LABEL[tab])}
                  {counts[tab] > 0 && (
                    <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-semibold text-primary">
                      {counts[tab]}
                    </span>
                  )}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {/* Direção da ordenação por tempo (espelha template-manager.tsx:814-822). */}
          <Button
            variant="outline"
            size="icon-sm"
            className="shrink-0"
            aria-label={t("sortAria")}
            title={t("sortTooltip")}
            onClick={handleToggleSort}
          >
            {effectiveDir(effectiveTab, sortDir) === "asc" ? (
              <ArrowUp className="size-4" />
            ) : (
              <ArrowDown className="size-4" />
            )}
          </Button>
        </div>
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">{t(EMPTY_KEY[effectiveTab])}</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
}: ConversationItemProps) {
  // Idioma ativo da UI: 'pt-BR' usa o locale ptBR; 'en' usa o default (en-US).
  const { i18n } = useTranslation("inbox");
  const dateLocale = i18n.language === "pt-BR" ? ptBR : undefined;
  const contact = conversation.contact;
  // Grupo (058): título via helper (sem contato); 1:1 usa nome/telefone.
  const isGroup = Boolean(conversation.is_group);
  const displayName = isGroup
    ? conversationTitle(conversation)
    : contact?.name || contact?.phone || "Unknown";
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: dateLocale,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        "focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar — grupo (058) usa ícone de pessoas; 1:1 usa foto/iniciais. */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground">
        {isGroup ? (
          <Users className="h-5 w-5 text-muted-foreground" />
        ) : contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {conversation.last_message_text || "No messages yet"}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}
