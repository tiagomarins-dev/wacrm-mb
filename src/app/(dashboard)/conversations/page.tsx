"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type {
  Conversation,
  ConversationStatus,
  Profile,
  AiProfilePublic,
} from "@/types";
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
import { AI_AGENT_LABEL } from "@/lib/ai-agent/constants";

const PAGE_SIZE = 25;

// Cor do "ponto" de status (espelha conversation-list.tsx:33-37).
const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};
// Chave i18n do label de cada status (não espalhar t() inline).
const STATUS_LABEL_KEY: Record<ConversationStatus, string> = {
  open: "statusOpen",
  pending: "statusPending",
  closed: "statusClosed",
};
// Filtro de status: 'all' + os valores de DB (NUNCA o rótulo traduzido — vai pro .eq).
type StatusFilter = "all" | ConversationStatus;
const STATUS_FILTERS: StatusFilter[] = ["all", "open", "pending", "closed"];

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

  const [rows, setRows] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
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

  // Busca paginada das conversas. Busca por nome/telefone usa o fallback de 2
  // passos (contatos casados → conversations.in('contact_id', ids)) — confiável,
  // independente da sintaxe de filtro em tabela referenciada.
  const fetchConversations = useCallback(async () => {
    setLoading(true);
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    // Passo 1 da busca: resolve os contatos que casam com o termo.
    let contactIds: string[] | null = null;
    if (search.trim()) {
      const term = `%${search.trim()}%`;
      const { data: cs } = await supabase
        .from("contacts")
        .select("id")
        .or(`name.ilike.${term},phone.ilike.${term}`);
      contactIds = (cs ?? []).map((c) => c.id);
      if (contactIds.length === 0) {
        // Nenhum contato casou → sem resultados, evita 2ª query.
        setRows([]);
        setTotalCount(0);
        setLoading(false);
        return;
      }
    }

    let query = supabase
      .from("conversations")
      .select("*, contact:contacts(*)", { count: "exact" })
      .order("last_message_at", { ascending: false, nullsFirst: false })
      .range(from, to);

    if (activeConnectionId) query = query.eq("connection_id", activeConnectionId);
    if (statusFilter !== "all") query = query.eq("status", statusFilter);
    if (contactIds) query = query.in("contact_id", contactIds);

    const { data, count, error } = await query;

    if (error) {
      toast.error(t("failedLoad"));
      setLoading(false);
      return;
    }
    setTotalCount(count ?? 0);
    setRows((data as Conversation[]) ?? []);
    setLoading(false);
  }, [supabase, page, search, statusFilter, activeConnectionId, t]);

  // Refetch a cada mudança de page/search/status/conexão. Disable espelha
  // contacts/page.tsx:185 (fetch faz setLoading síncrono no início).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchConversations();
  }, [fetchConversations]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasNext = page < totalPages - 1;
  const hasPrev = page > 0;
  const isFiltering = search.trim() !== "" || statusFilter !== "all";

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
              : t(STATUS_LABEL_KEY[statusFilter])}
            <ChevronDown className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="border-border bg-popover">
            {STATUS_FILTERS.map((s) => (
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
                {s === "all" ? t("filterAllStatus") : t(STATUS_LABEL_KEY[s])}
              </DropdownMenuItem>
            ))}
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
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={cn("size-2 rounded-full", STATUS_COLORS[conv.status])} />
                        {t(STATUS_LABEL_KEY[conv.status])}
                      </span>
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
