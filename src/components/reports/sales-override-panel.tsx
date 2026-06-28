"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2, ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { MetricCard } from "@/components/dashboard/metric-card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import type { ReportCoverage, AttributedSaleRow, ReportMember } from "@/types";

// Painel admin (Fase 3): cobertura de classificação/match + lista de vendas
// atribuídas com ação de override (cancelar/reatribuir). Lê só via RPC.
export function SalesOverridePanel({
  windowDays, connectionId, members,
}: { windowDays: number; connectionId: string | null; members: ReportMember[] }) {
  const { t } = useTranslation(["reports", "common"]);
  const supabase = createClient();
  const [coverage, setCoverage] = useState<ReportCoverage | null>(null);
  const [sales, setSales] = useState<AttributedSaleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const nameFor = useCallback(
    (id: string | null) => (id ? members.find((m) => m.user_id === id)?.full_name || id.slice(0, 8) : "—"),
    [members],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { p_window_days: windowDays, p_connection_id: connectionId };
      const [cov, list] = await Promise.all([
        supabase.rpc("report_coverage", params),
        supabase.rpc("report_attributed_sales", { ...params, p_status: "confirmed", p_limit: 100, p_offset: 0 }),
      ]);
      setCoverage(((cov.data as ReportCoverage[]) ?? [])[0] ?? null);
      setSales((list.data as AttributedSaleRow[]) ?? []);
    } catch {
      setSales([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, windowDays, connectionId]);

  useEffect(() => { void load(); }, [load]);

  // Cancela ou reatribui uma venda → recarrega a lista no sucesso.
  async function override(sale: AttributedSaleRow, action: "cancel" | "reassign", newAgentId?: string) {
    setBusyId(sale.id);
    try {
      const res = await fetch("/api/reports/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sale_id: sale.id, action, new_agent_id: newAgentId }),
      });
      if (!res.ok) throw new Error((await res.json())?.error || "fail");
      toast.success(t("overrideOk"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("overrideFail"));
    } finally {
      setBusyId(null);
    }
  }

  const matchTotal = coverage ? coverage.matched + coverage.no_match + coverage.ambiguous : 0;
  const matchPct = matchTotal ? Math.round((coverage!.matched / matchTotal) * 100) : 0;
  const classPct = coverage && coverage.convs_total ? Math.round((coverage.convs_classified / coverage.convs_total) * 100) : 0;

  return (
    <div className="space-y-4">
      <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
        <ShieldCheck className="size-4 text-primary" /> {t("adminPanel")}
      </h2>

      {/* Cobertura */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <MetricCard title={t("matchRate")} value={`${matchPct}%`} icon={ShieldCheck}
          subtitle={`${coverage?.matched ?? 0}/${matchTotal} ${t("matched")}`} />
        <MetricCard title={t("classifiedRate")} value={`${classPct}%`} icon={ShieldCheck}
          subtitle={`${coverage?.convs_classified ?? 0}/${coverage?.convs_total ?? 0}`} />
      </div>

      {/* Lista de vendas com override */}
      {loading ? (
        <div className="flex items-center justify-center py-10"><Loader2 className="size-5 animate-spin text-primary" /></div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-transparent">
                <TableHead className="text-muted-foreground">{t("contact")}</TableHead>
                <TableHead className="text-muted-foreground">{t("course")}</TableHead>
                <TableHead className="text-muted-foreground">{t("attendant")}</TableHead>
                <TableHead className="text-muted-foreground">{t("type")}</TableHead>
                <TableHead className="text-muted-foreground">{t("date")}</TableHead>
                <TableHead className="text-muted-foreground">{t("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">{t("empty")}</TableCell></TableRow>
              ) : (
                sales.map((s) => (
                  <TableRow key={s.id} className="border-border">
                    <TableCell className="text-foreground">{s.contact_name || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{s.nome_curso || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{nameFor(s.atendente_id)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {s.sale_type ? t(s.sale_type === "ativa" ? "active" : "passive") : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.data_matricula}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        {/* reatribuir: select de atendente */}
                        <select
                          defaultValue=""
                          disabled={busyId === s.id}
                          onChange={(e) => { if (e.target.value) void override(s, "reassign", e.target.value); }}
                          className="rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground"
                        >
                          <option value="">{t("reassign")}…</option>
                          {members.map((m) => (
                            <option key={m.user_id} value={m.user_id}>{m.full_name || m.user_id.slice(0, 8)}</option>
                          ))}
                        </select>
                        <Button size="sm" variant="ghost" disabled={busyId === s.id}
                          className="h-7 text-xs text-red-400 hover:text-red-300"
                          onClick={() => void override(s, "cancel")}>
                          {busyId === s.id ? <Loader2 className="size-3 animate-spin" /> : t("cancelSale")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
