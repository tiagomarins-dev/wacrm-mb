"use client";

// ============================================================
// Tabela por atendente do Pulso. Reusa as RPCs agent_response_time /
// agent_volume / agent_sales (050/052), que contam de now()−N dias —
// por isso só renderiza quando a janela termina ≈agora (endsNow);
// período custom no passado mostraria dado errado (H2 da auditoria).
// Espelha o modo "Geral" de reports/page.tsx:223-262.
// ============================================================
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Info, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { AgentResponseTime, AgentVolume, AgentSales, PulseAiRow, ReportMember } from "@/types";

// Linha consolidada por atendente (mesma união de reports/page.tsx:100-117).
type Row = AgentResponseTime & Partial<AgentVolume> & { name: string; vendas: number };

interface AgentsTableProps {
  windowDays: number;
  endsNow: boolean;
  connectionId: string | null;
  members: ReportMember[];
  /** Nome do perfil de IA da conta (ex.: "Ruth"); fallback = rótulo genérico. */
  aiName?: string | null;
  /** Atendente do filtro global (null = todos). RPCs 050/052 aceitam p_agent_id. */
  selectedAgent?: string | null;
  /** True quando o filtro global aponta pro agente de IA (id de perfil/sentinela). */
  isAiSelected?: boolean;
}

export function AgentsTable({ windowDays, endsNow, connectionId, members, aiName, selectedAgent = null, isAiSelected = false }: AgentsTableProps) {
  const { t } = useTranslation(["pulse"]);
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [aiRow, setAiRow] = useState<PulseAiRow | null>(null);
  const [loading, setLoading] = useState(true);

  const nameFor = useCallback(
    (id: string) => members.find((m) => m.user_id === id)?.full_name || id.slice(0, 8),
    [members],
  );

  useEffect(() => {
    if (!endsNow) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        // Obedece o filtro global: humano selecionado → só ele; IA → 050/052 voltam vazias (id não-humano)
        const params = { p_window_days: windowDays, p_connection_id: connectionId, p_agent_id: selectedAgent };
        const [rt, vol, sales, ai] = await Promise.all([
          supabase.rpc("agent_response_time", params),
          supabase.rpc("agent_volume", params),
          supabase.rpc("agent_sales", params),
          // linha do agente de IA (070/071 — 050 só conta humanos)
          supabase.rpc("pulse_ai_row", { p_window_days: windowDays, p_connection_id: connectionId }),
        ]);
        if (cancelled) return;
        setAiRow(((ai.data as PulseAiRow[]) ?? [])[0] ?? null);
        const rtRows = (rt.data as AgentResponseTime[]) ?? [];
        const volRows = (vol.data as AgentVolume[]) ?? [];
        const salesRows = (sales.data as AgentSales[]) ?? [];
        const volById = new Map(volRows.map((v) => [v.agent_id, v]));
        const salesById = new Map(salesRows.map((s) => [s.agent_id, s]));
        const ids = new Set<string>([
          ...rtRows.map((r) => r.agent_id), ...volRows.map((v) => v.agent_id), ...salesRows.map((s) => s.agent_id),
        ]);
        setRows(
          [...ids].map((id) => {
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
          }),
        );
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, windowDays, connectionId, endsNow, nameFor, selectedAgent]);

  const fmtMin = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(1)} ${t("minutesShort")}`);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-foreground">{t("agentsTitle")}</h2>
      {!endsNow ? (
        // Janela custom no passado: RPCs 050/052 contam de now()−N — dado seria errado
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{t("agentsUnavailablePast")}</span>
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t("colAgent")}</TableHead>
                <TableHead className="text-muted-foreground">{t("colFrt")}</TableHead>
                <TableHead className="text-muted-foreground">{t("colArt")}</TableHead>
                <TableHead className="text-muted-foreground">{t("colConversas")}</TableHead>
                <TableHead className="text-muted-foreground">{t("colMsgs")}</TableHead>
                <TableHead className="text-muted-foreground">{t("colTransfers")}</TableHead>
                <TableHead className="text-muted-foreground">{t("colHandoffs")}</TableHead>
                <TableHead className="text-muted-foreground">{t("colSales")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* Linha do agente de IA no topo (some quando um HUMANO específico está filtrado) */}
              {aiRow && aiRow.msgs_enviadas > 0 && (!selectedAgent || isAiSelected) && (
                <TableRow className="border-border bg-muted/30">
                  <TableCell className="font-medium text-foreground">
                    <span className="flex items-center gap-1.5">
                      <Bot className="size-3.5 text-primary" />
                      {aiName || t("aiAgent")}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{fmtMin(aiRow.frt_median)}</TableCell>
                  <TableCell className="text-muted-foreground">{fmtMin(aiRow.art_median)}</TableCell>
                  <TableCell className="text-muted-foreground">{aiRow.conversas_atendidas}</TableCell>
                  <TableCell className="text-muted-foreground">{aiRow.msgs_enviadas}</TableCell>
                  <TableCell className="text-muted-foreground">{aiRow.handoffs}</TableCell>
                  <TableCell className="text-muted-foreground">—</TableCell>
                  <TableCell className="font-medium text-foreground">{aiRow.vendas}</TableCell>
                </TableRow>
              )}
              {rows.length === 0 && !(aiRow && aiRow.msgs_enviadas > 0 && (!selectedAgent || isAiSelected)) ? (
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
      )}
    </section>
  );
}
