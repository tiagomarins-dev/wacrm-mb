"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BarChart3, Loader2, Clock, Timer, MessagesSquare, ArrowLeftRight, Bot, Info, ShoppingCart } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { useConversationStatuses } from "@/hooks/use-conversation-statuses";
import { resolveStatus } from "@/lib/inbox/conversation-statuses";
import { useFormat } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { MetricCard } from "@/components/dashboard/metric-card";
import { SalesOverridePanel } from "@/components/reports/sales-override-panel";
import { AiCostPanel } from "@/components/reports/ai-cost-panel";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { AgentResponseTime, AgentVolume, AgentSales, ReportMember } from "@/types";

// Conversa que "passou por" o atendente no dia (retorno da RPC agent_conversations, 065).
type DayConversation = {
  conversation_id: string; contact_id: string; contact_name: string | null;
  contact_phone: string | null; last_message_text: string | null;
  last_message_at: string | null; status: string; assigned_agent_id: string | null;
};

const WINDOWS = [7, 30, 90] as const;

// Linha consolidada por atendente (tempo de resposta + volume + vendas).
type Row = AgentResponseTime & Partial<AgentVolume> & { name: string; vendas: number };

// Página de relatórios de atendimento. Operador vê o próprio; admin/owner vê
// "Geral" + dropdown por operador. Lê as RPCs agent_response_time / agent_volume
// (a própria RPC força o operador ao próprio id — segurança não depende do front).
export default function ReportsPage() {
  const { t } = useTranslation(["reports", "common"]);
  const supabase = createClient();
  const router = useRouter();
  const { user, canEditSettings, isOwner } = useAuth();
  const { activeConnectionId } = useActiveConnection();
  const { statuses } = useConversationStatuses();
  const { formatDateTime } = useFormat();

  const [windowDays, setWindowDays] = useState<number>(30);
  const [members, setMembers] = useState<ReportMember[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null); // null = Geral (admin)
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [noHours, setNoHours] = useState(false);

  // Seção owner-only: conversas que passaram por um atendente num dia (065).
  const [dayAgent, setDayAgent] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [dayConversations, setDayConversations] = useState<DayConversation[]>([]);
  const [dayLoading, setDayLoading] = useState(false);

  // Admin/owner: carrega operadores (agent+) para o dropdown. Viewer some.
  useEffect(() => {
    if (!canEditSettings) return;
    (async () => {
      const res = await fetch("/api/account/members", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { members: ReportMember[] };
      setMembers(json.members.filter((m) => m.account_role !== "viewer"));
    })();
  }, [canEditSettings]);

  // Resolve o nome do atendente a partir do id (dropdown/tabela).
  const nameFor = useCallback(
    (id: string) => members.find((m) => m.user_id === id)?.full_name || id.slice(0, 8),
    [members],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // operador não-admin: sempre o próprio (a RPC também força isso no servidor)
      const agentParam = canEditSettings ? selectedAgent : (user?.id ?? null);
      const params = { p_window_days: windowDays, p_connection_id: activeConnectionId, p_agent_id: agentParam };
      const [rt, vol, sales, bh] = await Promise.all([
        supabase.rpc("agent_response_time", params),
        supabase.rpc("agent_volume", params),
        supabase.rpc("agent_sales", params),
        // aviso 24/7: só quando há conexão ativa e ela não tem horário configurado
        activeConnectionId
          ? supabase.from("business_hours").select("id").eq("connection_id", activeConnectionId).maybeSingle()
          : Promise.resolve({ data: null, error: null }),
      ]);
      const rtRows = (rt.data as AgentResponseTime[]) ?? [];
      const volRows = (vol.data as AgentVolume[]) ?? [];
      const salesRows = (sales.data as AgentSales[]) ?? [];
      const volById = new Map(volRows.map((v) => [v.agent_id, v]));
      const salesById = new Map(salesRows.map((s) => [s.agent_id, s]));
      // une os conjuntos por atendente (qualquer um pode trazer ids)
      const ids = new Set<string>([
        ...rtRows.map((r) => r.agent_id), ...volRows.map((v) => v.agent_id), ...salesRows.map((s) => s.agent_id),
      ]);
      const merged: Row[] = [...ids].map((id) => {
        const rt0 = rtRows.find((r) => r.agent_id === id);
        const v0 = volById.get(id);
        return {
          agent_id: id,
          frt_median: rt0?.frt_median ?? null,
          frt_avg: rt0?.frt_avg ?? null,
          art_median: rt0?.art_median ?? null,
          art_avg: rt0?.art_avg ?? null,
          samples: rt0?.samples ?? 0,
          conversas_atendidas: v0?.conversas_atendidas ?? 0,
          msgs_enviadas: v0?.msgs_enviadas ?? 0,
          transferencias: v0?.transferencias ?? 0,
          handoffs_ia: v0?.handoffs_ia ?? 0,
          vendas: salesById.get(id)?.vendas ?? 0,
          name: nameFor(id),
        };
      });
      setRows(merged);
      setNoHours(Boolean(activeConnectionId) && !bh.data);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, canEditSettings, selectedAgent, user?.id, windowDays, activeConnectionId, nameFor]);

  useEffect(() => {
    void load();
  }, [load]);

  // Busca as conversas que passaram pelo atendente no dia escolhido (owner-only, RPC 065).
  // O gate real é server-side (a RPC nega se não for owner); captura erro p/ não sumir silencioso.
  const loadDay = useCallback(async () => {
    if (!dayAgent || !selectedDay) { setDayConversations([]); return; }
    setDayLoading(true);
    try {
      const from = new Date(`${selectedDay}T00:00:00`);
      const to = new Date(from);
      to.setDate(to.getDate() + 1);
      const { data, error } = await supabase.rpc("agent_conversations", {
        p_agent_id: dayAgent,
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_connection_id: activeConnectionId,
      });
      if (error) { toast.error(t("dayLoadFailed")); setDayConversations([]); return; }
      setDayConversations((data ?? []) as DayConversation[]);
    } finally {
      setDayLoading(false);
    }
  }, [dayAgent, selectedDay, activeConnectionId, supabase, t]);

  useEffect(() => {
    void loadDay();
  }, [loadDay]);

  // Modo "cards" quando há um atendente único em foco (operador, ou admin que
  // escolheu um operador). "Geral" do admin (selectedAgent null) vira tabela.
  const isGeral = canEditSettings && selectedAgent === null;
  const single = !isGeral ? rows[0] : undefined;

  // Formata minutos → "12,3 min" ou "—" (pendente / sem amostra).
  const fmtMin = (n: number | null | undefined) =>
    n == null ? t("pending") : `${n.toFixed(1)} ${t("minutesShort")}`;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <BarChart3 className="size-5 text-primary" />
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Dropdown de operador (admin/owner) */}
          {canEditSettings && (
            <select
              value={selectedAgent ?? ""}
              onChange={(e) => setSelectedAgent(e.target.value || null)}
              className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
            >
              <option value="">{t("allOperators")}</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name || m.user_id.slice(0, 8)}
                </option>
              ))}
            </select>
          )}
          {/* Seletor de período (espelha o dashboard) */}
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowDays(w)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  windowDays === w ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {w}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Aviso 24/7 quando a conexão ativa não tem horário configurado */}
      {noHours && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{t("noBusinessHours")}</span>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : isGeral ? (
        // Visão geral (admin): uma linha por atendente.
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t("selectOperator")}</TableHead>
                <TableHead className="text-muted-foreground">{t("frt")}</TableHead>
                <TableHead className="text-muted-foreground">{t("art")}</TableHead>
                <TableHead className="text-muted-foreground">{t("conversationsHandled")}</TableHead>
                <TableHead className="text-muted-foreground">{t("messagesSent")}</TableHead>
                <TableHead className="text-muted-foreground">{t("transfers")}</TableHead>
                <TableHead className="text-muted-foreground">{t("aiHandoffs")}</TableHead>
                <TableHead className="text-muted-foreground">{t("sales")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => (
                  <TableRow key={r.agent_id} className="border-border">
                    <TableCell className="font-medium text-foreground">{r.name}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtMin(r.frt_median)}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtMin(r.art_median)}</TableCell>
                    <TableCell className="text-muted-foreground">{r.conversas_atendidas ?? 0}</TableCell>
                    <TableCell className="text-muted-foreground">{r.msgs_enviadas ?? 0}</TableCell>
                    <TableCell className="text-muted-foreground">{r.transferencias ?? 0}</TableCell>
                    <TableCell className="text-muted-foreground">{r.handoffs_ia ?? 0}</TableCell>
                    <TableCell className="font-medium text-foreground">{r.vendas}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      ) : !single ? (
        <div className="rounded-lg border border-border py-16 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        // Cards do atendente em foco (operador, ou admin com operador escolhido).
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard title={t("frt")} value={fmtMin(single.frt_median)} icon={Clock}
            subtitle={`${t("median")} · ${t("avg")}: ${fmtMin(single.frt_avg)}`} />
          <MetricCard title={t("art")} value={fmtMin(single.art_median)} icon={Timer}
            subtitle={`${t("median")} · ${t("avg")}: ${fmtMin(single.art_avg)}`} />
          <MetricCard title={t("conversationsHandled")} value={String(single.conversas_atendidas ?? 0)} icon={MessagesSquare} />
          <MetricCard title={t("messagesSent")} value={String(single.msgs_enviadas ?? 0)} icon={MessagesSquare} />
          <MetricCard title={t("transfers")} value={String(single.transferencias ?? 0)} icon={ArrowLeftRight} />
          <MetricCard title={t("aiHandoffs")} value={String(single.handoffs_ia ?? 0)} icon={Bot} />
          <MetricCard title={t("sales")} value={String(single.vendas)} icon={ShoppingCart} />
        </div>
      )}

      {/* Painel admin (Fase 3): cobertura + override de vendas. */}
      {canEditSettings && (
        <div className="mt-8 border-t border-border pt-6">
          <SalesOverridePanel windowDays={windowDays} connectionId={activeConnectionId} members={members} />
        </div>
      )}

      {/* Custo do agente de IA (082): admin+ apenas — é dado financeiro. */}
      {canEditSettings && (
        <AiCostPanel windowDays={windowDays} connectionId={activeConnectionId} />
      )}

      {/* Seção OWNER-only (065): conversas que passaram por um atendente no dia. */}
      {isOwner && (
        <section className="mt-8 border-t border-border pt-6">
          <h2 className="mb-3 text-sm font-semibold text-foreground">{t("dayTitle")}</h2>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              value={dayAgent ?? ""}
              onChange={(e) => setDayAgent(e.target.value || null)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            >
              <option value="">{t("daySelectAgent")}</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>{m.full_name}</option>
              ))}
            </select>
            <input
              type="date"
              value={selectedDay}
              onChange={(e) => setSelectedDay(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            />
          </div>

          {dayLoading ? (
            <Loader2 className="size-5 animate-spin text-primary" />
          ) : !dayAgent ? (
            <p className="text-sm text-muted-foreground">{t("daySelectAgent")}</p>
          ) : dayConversations.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("dayEmpty")}</p>
          ) : (
            <div className="overflow-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">{t("dayColName")}</TableHead>
                    <TableHead className="hidden text-muted-foreground md:table-cell">{t("dayColPhone")}</TableHead>
                    <TableHead className="hidden text-muted-foreground lg:table-cell">{t("dayColLastMsg")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("dayColStatus")}</TableHead>
                    <TableHead className="hidden text-muted-foreground md:table-cell">{t("dayColDate")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dayConversations.map((cv) => {
                    const st = resolveStatus(statuses, cv.status);
                    return (
                      <TableRow
                        key={cv.conversation_id}
                        className="cursor-pointer border-border hover:bg-muted/50"
                        onClick={() => router.push(`/inbox?c=${cv.conversation_id}`)}
                      >
                        <TableCell className="font-medium text-foreground">{cv.contact_name || cv.contact_phone || "—"}</TableCell>
                        <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">{cv.contact_phone}</TableCell>
                        <TableCell className="hidden max-w-[280px] lg:table-cell">
                          <span className="block truncate text-xs text-muted-foreground" title={cv.last_message_text ?? ""}>
                            {cv.last_message_text}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-medium"
                            style={{ backgroundColor: `${st.color}20`, color: st.color }}
                          >
                            {st.label}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                          {cv.last_message_at ? formatDateTime(cv.last_message_at) : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
