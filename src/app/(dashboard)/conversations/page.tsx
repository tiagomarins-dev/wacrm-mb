"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type {
  Conversation,
  Profile,
  AiProfilePublic,
} from "@/types";
import { useConversationStatuses } from "@/hooks/use-conversation-statuses";
import { resolveStatus } from "@/lib/inbox/conversation-statuses";
import { useConversationWorkspace } from "@/hooks/use-conversation-workspace";
import { ConversationWorkspace } from "@/components/inbox/conversation-workspace";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { GatedButton } from "@/components/ui/gated-button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Search,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MessagesSquare,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useCan } from "@/hooks/use-can";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { useFormat } from "@/lib/i18n/format";
import { resolveAssignee, type Assignee } from "@/lib/inbox/assignee";
import { AI_AGENT_LABEL, AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";
import { buildSearchParams, type AgentFilter, type DateRange } from "@/lib/inbox/search-conversations-params";
import { IntentBadge } from "@/components/conversations/intent-badge";

const PAGE_SIZE = 25;

// Tag da conta para o filtro (subset de Tag — só o que o dropdown usa).
type AccountTag = { id: string; name: string; color: string };

// Filtro de status: 'all' + a key de qualquer status da conta (system/custom,
// 062). NUNCA o rótulo traduzido — vai pro .eq. Cores/labels vêm do hook.
type StatusFilter = string;
// Presets do filtro de data (custom entra via 2 inputs, fora deste array).
const DATE_RANGES: DateRange[] = ["today", "week", "month", "6m", "12m", "all"];
// Opções do filtro de intenção (067). '__none__' = não classificada (report_intent NULL).
const INTENT_OPTIONS = ["all", "vendas", "suporte", "outro", "__none__"] as const;

// Traduz o discriminador do responsável p/ exibição.
function assigneeLabel(a: Assignee, t: (k: string) => string): string {
  switch (a.kind) {
    case "unassigned":
      return t("unassigned");
    case "ai-bot":
      return AI_AGENT_LABEL;
    case "ai-profile":
      return `🤖 ${a.nome}`;
    case "human":
      return a.name || t("unassigned");
    case "unknown":
      return "—";
  }
}

export default function ConversationsPage() {
  const { t } = useTranslation(["conversations", "common"]);
  const { formatDateTime } = useFormat();
  const supabase = createClient();
  const { activeConnectionId } = useActiveConnection();
  // Status da conta (system+custom, 062) — label/cor do badge e opções do filtro.
  const { statuses } = useConversationStatuses();

  const [rows, setRows] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Filtro por responsável: 'all' / 'unassigned' / uuid (humano, perfil IA ou bot).
  const [agentFilter, setAgentFilter] = useState<AgentFilter>("all");
  // Filtro de data (por last_message_at). Padrão "Esse mês" — não puxa TODAS as
  // conversas de cara. customFrom/To só valem quando dateRange === "custom".
  const [dateRange, setDateRange] = useState<DateRange>("month");
  const [customFrom, setCustomFrom] = useState<Date | null>(null);
  const [customTo, setCustomTo] = useState<Date | null>(null);
  const [page, setPage] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  // Mapas p/ resolver o responsável (carregados 1x). Espelha message-thread.tsx:206-242.
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [aiProfiles, setAiProfiles] = useState<AiProfilePublic[]>([]);
  // Filtro por tag do contato (063): 'all' ou uuid da tag. Tags da conta p/ o dropdown.
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [accountTags, setAccountTags] = useState<AccountTag[]>([]);
  // Filtro por intenção classificada (067): 'all' / valor / '__none__'.
  const [intentFilter, setIntentFilter] = useState<string>("all");
  // Seleção múltipla (page-scoped) p/ fechar em lote. Espelha contacts/page.tsx.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCloseOpen, setBulkCloseOpen] = useState(false);
  const canEdit = useCan("send-messages");

  // Responsáveis: membros humanos (profiles, RLS) + perfis de IA (view pública).
  useEffect(() => {
    let cancelled = false;
    const sb = createClient();
    sb.from("profiles")
      .select("*")
      .then(({ data }) => {
        if (!cancelled) setProfiles((data as Profile[]) ?? []);
      });
    sb.from("ai_profiles_public")
      .select("id, nome, enabled")
      .eq("enabled", true)
      .then(({ data }) => {
        if (!cancelled) setAiProfiles((data as AiProfilePublic[]) ?? []);
      });
    // Tags da conta p/ o filtro (RLS já isola por conta — sem .eq).
    sb.from("tags")
      .select("id, name, color")
      .order("name")
      .then(({ data }) => {
        if (!cancelled) setAccountTags((data as AccountTag[]) ?? []);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Busca paginada das conversas via RPC `search_conversations`: filtro por
  // conexão/status/responsável + busca (nome/telefone/última msg/conteúdo de
  // mensagem/transcrição) + paginação + total, tudo no banco (RLS por conta).
  // O termo de busca só vai pro banco com >= 3 chars (regra no buildSearchParams).
  const fetchConversations = useCallback(async () => {
    setLoading(true);
    // Limpa a seleção: paginação/filtro trocam as linhas visíveis (espelha
    // contacts/page.tsx:122) — senão a barra de bulk agiria sobre linhas fora da página.
    setSelected(new Set());
    const { data, error } = await supabase.rpc(
      "search_conversations",
      buildSearchParams({ search, statusFilter, agentFilter, activeConnectionId, page, dateRange, customFrom, customTo, tagFilter, intentFilter })
    );

    if (error) {
      toast.error(t("failedLoad"));
      setLoading(false);
      return;
    }
    // A RPC devolve { data: <conversa+contato>, total_count } por linha.
    const list = (data ?? []) as { data: Conversation; total_count: number }[];
    setRows(list.map((r) => r.data));
    setTotalCount(Number(list[0]?.total_count ?? 0));
    setLoading(false);
  }, [supabase, page, search, statusFilter, agentFilter, activeConnectionId, dateRange, customFrom, customTo, tagFilter, intentFilter, t]);

  // Refetch a cada mudança de page/search/status/conexão. Disable espelha
  // contacts/page.tsx:185 (fetch faz setLoading síncrono no início).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConversations();
  }, [fetchConversations]);

  // Seleção múltipla page-scoped (espelha contacts/page.tsx).
  const pageIds = rows.map((r) => r.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const someSelected = pageIds.some((id) => selected.has(id));
  function toggleSelectAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }
  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Fecha em lote as conversas selecionadas (status → 'closed'). Saem de
  // fila/sla/minhas no inbox (via realtime). Client RLS: conversations_update = agent+.
  async function bulkClose() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const { error } = await supabase
      .from("conversations")
      .update({ status: "closed" })
      .in("id", ids);
    if (error) {
      toast.error(t("bulkCloseError"));
      return;
    }
    setRows((prev) =>
      prev.map((c) => (selected.has(c.id) ? { ...c, status: "closed" } : c)),
    );
    setSelected(new Set());
    setBulkCloseOpen(false);
    toast.success(t("bulkCloseDone", { count: ids.length }));
  }

  // Trocar de conexão zera o filtro de atendente (a pessoa pode não atender lá)
  // e volta pra 1ª página — o atendente é específico de uma conexão.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAgentFilter("all");
    setPage(0);
  }, [activeConnectionId]);

  // Motor da conversa compartilhado (mesmo do inbox) — abre a conversa à direita
  // sem sair da tela. Lista = rows (filtro por RPC); patch atualiza a linha visível;
  // conv fora do filtro é ignorada (upsert noop). Canal realtime próprio.
  const ws = useConversationWorkspace({
    channelName: "conversations-realtime",
    conversations: rows,
    patchConversation: (id, updater) =>
      setRows((prev) => prev.map((c) => (c.id === id ? updater(c) : c))),
    upsertConversation: () => {},
  });

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;
  const isFiltering =
    search.trim() !== "" ||
    statusFilter !== "all" ||
    agentFilter !== "all" ||
    tagFilter !== "all" ||
    intentFilter !== "all" ||
    dateRange !== "month" ||
    !!customFrom ||
    !!customTo;

  return (
    // Full-bleed (shell sem padding): coluna que preenche a tela. Header+filtros
    // fixos (shrink-0); abaixo o split tabela↔conversa.
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header + filtros (largura cheia, não rolam) */}
      <div className="shrink-0 space-y-4 border-b border-border p-4 sm:p-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>

      {/* Busca + filtro de status */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder={t("searchPlaceholder")}
            className="bg-card pl-8 text-foreground placeholder:text-muted-foreground"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            {statusFilter === "all"
              ? t("filterAllStatus")
              : resolveStatus(statuses, statusFilter).label}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-popover">
            {["all", ...statuses.map((s) => s.key)].map((s) => (
              <DropdownMenuItem
                key={s}
                onClick={() => {
                  setStatusFilter(s);
                  setPage(0);
                }}
                className={cn(
                  "text-sm",
                  statusFilter === s ? "text-primary" : "text-popover-foreground"
                )}
              >
                {s === "all" ? t("filterAllStatus") : resolveStatus(statuses, s).label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Filtro por tag do contato (063). 'Todas as tags' = sem filtro. */}
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            {tagFilter === "all"
              ? t("filterAllTags")
              : accountTags.find((tg) => tg.id === tagFilter)?.name ?? t("filterAllTags")}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-popover">
            <DropdownMenuItem
              onClick={() => {
                setTagFilter("all");
                setPage(0);
              }}
              className={cn(
                "text-sm",
                tagFilter === "all" ? "text-primary" : "text-popover-foreground"
              )}
            >
              {t("filterAllTags")}
            </DropdownMenuItem>
            {accountTags.map((tg) => (
              <DropdownMenuItem
                key={tg.id}
                onClick={() => {
                  setTagFilter(tg.id);
                  setPage(0);
                }}
                className={cn(
                  "flex items-center gap-2 text-sm",
                  tagFilter === tg.id ? "text-primary" : "text-popover-foreground"
                )}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: tg.color }}
                />
                {tg.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Filtro por intenção classificada (067). '__none__' = não classificada. */}
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            {intentFilter === "all"
              ? t("filterAllIntents")
              : t(`intent_${intentFilter === "__none__" ? "none" : intentFilter}`)}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-popover">
            {INTENT_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt}
                onClick={() => {
                  setIntentFilter(opt);
                  setPage(0);
                }}
                className={cn(
                  "text-sm",
                  intentFilter === opt ? "text-primary" : "text-popover-foreground"
                )}
              >
                {opt === "all"
                  ? t("filterAllIntents")
                  : t(`intent_${opt === "__none__" ? "none" : opt}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Filtro de data (por last_message_at). Padrão "Esse mês" → reduz a
            carga; "Personalizado" abre 2 inputs de data (fuso local). */}
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            {t(`date_${dateRange}`)}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-popover">
            {DATE_RANGES.map((r) => (
              <DropdownMenuItem
                key={r}
                onClick={() => {
                  setDateRange(r);
                  setPage(0);
                }}
                className={cn(
                  "text-sm",
                  dateRange === r ? "text-primary" : "text-popover-foreground"
                )}
              >
                {t(`date_${r}`)}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              onClick={() => {
                setDateRange("custom");
                setPage(0);
              }}
              className={cn(
                "text-sm",
                dateRange === "custom" ? "text-primary" : "text-popover-foreground"
              )}
            >
              {t("date_custom")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Range personalizado: inputs nativos (sem Calendar no projeto).
            "T00:00" sem Z → interpretado no fuso local, casa com resolveDateRange. */}
        {dateRange === "custom" && (
          <div className="flex items-center gap-1">
            <input
              type="date"
              className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
              onChange={(e) => {
                setCustomFrom(e.target.value ? new Date(e.target.value + "T00:00") : null);
                setPage(0);
              }}
            />
            <span className="text-xs text-muted-foreground">→</span>
            <input
              type="date"
              className="h-9 rounded-md border border-border bg-card px-2 text-sm text-foreground"
              onChange={(e) => {
                setCustomTo(e.target.value ? new Date(e.target.value + "T00:00") : null);
                setPage(0);
              }}
            />
          </div>
        )}

        {/* Filtro por responsável: Todos / perfis IA / bot / humanos / Não atribuído.
            Espelha o seletor de responsável do inbox (message-thread.tsx:1016-1090). */}
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex h-9 items-center gap-1 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            {agentFilter === "all"
              ? t("filterAllAgents")
              : agentFilter === "unassigned"
                ? t("unassigned")
                : assigneeLabel(resolveAssignee(agentFilter, profiles, aiProfiles), t)}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-popover">
            <DropdownMenuItem
              onClick={() => {
                setAgentFilter("all");
                setPage(0);
              }}
              className={cn("text-sm", agentFilter === "all" ? "text-primary" : "text-popover-foreground")}
            >
              {t("filterAllAgents")}
            </DropdownMenuItem>
            {/* Perfis de IA */}
            {aiProfiles.map((ap) => (
              <DropdownMenuItem
                key={ap.id}
                onClick={() => {
                  setAgentFilter(ap.id);
                  setPage(0);
                }}
                className={cn("text-sm", agentFilter === ap.id ? "text-primary" : "text-popover-foreground")}
              >
                🤖 {ap.nome}
              </DropdownMenuItem>
            ))}
            {/* Bot genérico (Assistente IA) */}
            <DropdownMenuItem
              onClick={() => {
                setAgentFilter(AI_AGENT_USER_ID);
                setPage(0);
              }}
              className={cn(
                "text-sm",
                agentFilter === AI_AGENT_USER_ID ? "text-primary" : "text-popover-foreground"
              )}
            >
              🤖 {AI_AGENT_LABEL}
            </DropdownMenuItem>
            {profiles.length > 0 && <DropdownMenuSeparator className="bg-border" />}
            {/* Membros humanos */}
            {profiles.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => {
                  setAgentFilter(p.user_id);
                  setPage(0);
                }}
                className={cn("text-sm", agentFilter === p.user_id ? "text-primary" : "text-popover-foreground")}
              >
                {p.full_name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator className="bg-border" />
            <DropdownMenuItem
              onClick={() => {
                setAgentFilter("unassigned");
                setPage(0);
              }}
              className={cn(
                "text-sm",
                agentFilter === "unassigned" ? "text-primary" : "text-muted-foreground"
              )}
            >
              {t("unassigned")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </div>

      {/* Split: tabela filtrada (esq) ↔ conversa+contato (dir), sem sair da tela. */}
      <div className="flex flex-1 overflow-hidden">
        {/* Painel esquerdo: tabela + paginação. Some no mobile quando há conversa
            aberta (a conversa ocupa a tela toda). */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 flex-col overflow-hidden p-4 sm:p-6",
            ws.hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
      {/* Barra de ação em lote — aparece com N selecionadas */}
      {selected.size > 0 && (
        <div className="mb-2 flex items-center justify-between gap-4 rounded-lg border border-border bg-muted/40 px-4 py-2">
          <p className="text-sm text-foreground">
            <span className="font-medium">{selected.size}</span>{" "}
            {t("selectedSuffix", { count: selected.size })}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelected(new Set())}
              className="text-muted-foreground hover:text-foreground"
            >
              {t("common:clear")}
            </Button>
            <GatedButton
              size="sm"
              canAct={canEdit}
              gateReason="close conversations"
              onClick={() => setBulkCloseOpen(true)}
            >
              <CheckCircle2 className="size-4" />
              {t("bulkClose")}
            </GatedButton>
          </div>
        </div>
      )}

      {/* Tabela */}
      <div className="overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  indeterminate={!allSelected && someSelected}
                  onCheckedChange={toggleSelectAll}
                  aria-label={t("selectAllAria")}
                />
              </TableHead>
              <TableHead className="text-muted-foreground">{t("colName")}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t("colPhone")}</TableHead>
              <TableHead className="hidden text-muted-foreground lg:table-cell">{t("colLastMsg")}</TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">{t("colAssignee")}</TableHead>
              <TableHead className="text-muted-foreground">{t("colStatus")}</TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">{t("colIntent")}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t("colDate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={8} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <MessagesSquare className="size-8 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">
                      {isFiltering ? t("noMatch") : t("empty")}
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              rows.map((conv) => {
                const displayName =
                  conv.contact?.name || conv.contact?.phone || "—";
                return (
                  <TableRow
                    key={conv.id}
                    className={cn(
                      "cursor-pointer border-border hover:bg-muted/50",
                      ws.activeConversation?.id === conv.id &&
                        "border-l-2 border-l-primary bg-muted/70",
                    )}
                    onClick={() => ws.select(conv)}
                  >
                    <TableCell className="w-10" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(conv.id)}
                        onCheckedChange={() => toggleSelect(conv.id)}
                        aria-label={t("selectAria", {
                          name: conv.contact?.name || conv.contact?.phone || "",
                        })}
                      />
                    </TableCell>
                    <TableCell className="font-medium text-foreground">{displayName}</TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                      {conv.contact?.phone}
                    </TableCell>
                    <TableCell className="hidden max-w-[280px] lg:table-cell">
                      <span
                        className="block truncate text-xs text-muted-foreground"
                        title={conv.last_message_text}
                      >
                        {conv.last_message_text}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                      {assigneeLabel(
                        resolveAssignee(conv.assigned_agent_id, profiles, aiProfiles),
                        t
                      )}
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const st = resolveStatus(statuses, conv.status);
                        return (
                          <span
                            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                            style={{ backgroundColor: `${st.color}20`, color: st.color }}
                          >
                            {st.label}
                          </span>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <IntentBadge
                        value={conv.report_intent}
                        label={conv.report_intent ? t(`intent_${conv.report_intent}`) : undefined}
                      />
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {conv.last_message_at ? formatDateTime(conv.last_message_at) : "—"}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Paginação */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            {t("showing", {
              from: page * PAGE_SIZE + 1,
              to: Math.min((page + 1) * PAGE_SIZE, totalCount),
              total: totalCount,
            })}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("pageOf", { page: page + 1, total: totalPages })}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasPrev}
              onClick={() => setPage((p) => p - 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              disabled={!hasNext}
              onClick={() => setPage((p) => p + 1)}
              className="border-border text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </Button>
          </div>
        </div>
      )}
        </div>

        {/* Painel direito: só quando há conversa aberta — assim a tabela fica
            CHEIA enquanto nada está selecionado. O "voltar" (desktop) fecha a
            conversa e volta pra lista. */}
        {ws.hasActiveConv && <ConversationWorkspace ws={ws} showDesktopBack />}
      </div>

      {/* Confirmação de fechar em lote */}
      <Dialog open={bulkCloseOpen} onOpenChange={setBulkCloseOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("bulkCloseTitle", { count: selected.size })}</DialogTitle>
            <DialogDescription>{t("bulkCloseConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setBulkCloseOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={bulkClose}>{t("bulkClose")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
