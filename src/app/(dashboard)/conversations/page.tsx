"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type {
  Conversation,
  Profile,
  AiProfilePublic,
} from "@/types";
import { useConversationStatuses } from "@/hooks/use-conversation-statuses";
import { resolveStatus } from "@/lib/inbox/conversation-statuses";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { useFormat } from "@/lib/i18n/format";
import { resolveAssignee, type Assignee } from "@/lib/inbox/assignee";
import { AI_AGENT_LABEL, AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";
import { buildSearchParams, type AgentFilter, type DateRange } from "@/lib/inbox/search-conversations-params";

const PAGE_SIZE = 25;

// Filtro de status: 'all' + a key de qualquer status da conta (system/custom,
// 062). NUNCA o rótulo traduzido — vai pro .eq. Cores/labels vêm do hook.
type StatusFilter = string;
// Presets do filtro de data (custom entra via 2 inputs, fora deste array).
const DATE_RANGES: DateRange[] = ["today", "week", "month", "6m", "12m", "all"];

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
  const router = useRouter();
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
    const { data, error } = await supabase.rpc(
      "search_conversations",
      buildSearchParams({ search, statusFilter, agentFilter, activeConnectionId, page, dateRange, customFrom, customTo })
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
  }, [supabase, page, search, statusFilter, agentFilter, activeConnectionId, dateRange, customFrom, customTo, t]);

  // Refetch a cada mudança de page/search/status/conexão. Disable espelha
  // contacts/page.tsx:185 (fetch faz setLoading síncrono no início).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConversations();
  }, [fetchConversations]);

  // Trocar de conexão zera o filtro de atendente (a pessoa pode não atender lá)
  // e volta pra 1ª página — o atendente é específico de uma conexão.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAgentFilter("all");
    setPage(0);
  }, [activeConnectionId]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;
  const isFiltering =
    search.trim() !== "" ||
    statusFilter !== "all" ||
    agentFilter !== "all" ||
    dateRange !== "month" ||
    !!customFrom ||
    !!customTo;

  return (
    <div className="space-y-6">
      {/* Header */}
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

      {/* Tabela */}
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="text-muted-foreground">{t("colName")}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t("colPhone")}</TableHead>
              <TableHead className="hidden text-muted-foreground lg:table-cell">{t("colLastMsg")}</TableHead>
              <TableHead className="hidden text-muted-foreground sm:table-cell">{t("colAssignee")}</TableHead>
              <TableHead className="text-muted-foreground">{t("colStatus")}</TableHead>
              <TableHead className="hidden text-muted-foreground md:table-cell">{t("colDate")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="py-12 text-center">
                  <div className="flex flex-col items-center gap-2">
                    <Loader2 className="size-6 animate-spin text-primary" />
                    <p className="text-sm text-muted-foreground">{t("loading")}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="py-12 text-center">
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
                    className="cursor-pointer border-border hover:bg-muted/50"
                    onClick={() => router.push(`/inbox?c=${conv.id}`)}
                  >
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
  );
}
