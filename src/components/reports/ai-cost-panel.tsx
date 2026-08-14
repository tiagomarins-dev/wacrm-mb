"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowLeftRight, Bot, Coins, Loader2, MessagesSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useFormat } from "@/lib/i18n/format";
import { useConversationWorkspace } from "@/hooks/use-conversation-workspace";
import { formatTokens, formatUsd, toNumber } from "@/lib/reports/ai-cost";
import { MetricCard } from "@/components/dashboard/metric-card";
import { ConversationWorkspace } from "@/components/inbox/conversation-workspace";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import type { AiCostConversationRow, AiCostSummary, Conversation } from "@/types";

// Painel admin+ (082): quanto o agente de IA custou no período, em cards, e o
// custo de cada conversa numa tabela clicável até o inbox. Lê só via RPC — a
// checagem de papel mora dentro dela, o gate do front é só de interface.
export function AiCostPanel({
  windowDays, connectionId,
}: { windowDays: number; connectionId: string | null }) {
  const { t } = useTranslation(["reports", "common"]);
  const supabase = createClient();
  const { formatDateTime } = useFormat();
  const [summary, setSummary] = useState<AiCostSummary | null>(null);
  const [rows, setRows] = useState<AiCostConversationRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Conversas já hidratadas por clique. O relatório lista IDs; o workspace
  // precisa da linha completa com o contato joined, então buscamos sob demanda
  // e guardamos — reabrir a mesma conversa não refaz a consulta.
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [abrindoId, setAbrindoId] = useState<string | null>(null);

  // Motor de conversa compartilhado com /inbox e /conversations. A lista aqui
  // são só as conversas já abertas: upsert é noop porque o relatório não é uma
  // caixa de entrada — nada deve entrar nele por evento de realtime.
  const ws = useConversationWorkspace({
    channelName: "ai-cost-realtime",
    conversations: convs,
    patchConversation: (id, updater) =>
      setConvs((prev) => prev.map((c) => (c.id === id ? updater(c) : c))),
    upsertConversation: () => {},
    removeConversation: (id) => setConvs((prev) => prev.filter((c) => c.id !== id)),
  });

  // Abre a conversa da linha no painel lateral, sem sair do relatório. Busca com
  // o contato joined: o ws alimenta a ContactSidebar a partir de conv.contact.
  const abrirConversa = useCallback(
    async (convId: string) => {
      const jaTem = convs.find((c) => c.id === convId);
      if (jaTem) {
        ws.select(jaTem);
        return;
      }
      setAbrindoId(convId);
      const { data } = await supabase
        .from("conversations")
        .select("*, contact:contacts(*)")
        .eq("id", convId)
        .maybeSingle();
      setAbrindoId(null);
      const conv = (data as Conversation | null) ?? null;
      if (!conv) return;
      setConvs((prev) => [...prev.filter((c) => c.id !== conv.id), conv]);
      ws.select(conv);
    },
    [convs, supabase, ws],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = { p_window_days: windowDays, p_connection_id: connectionId };
      const [sum, list] = await Promise.all([
        supabase.rpc("ai_cost_summary", params),
        supabase.rpc("ai_cost_by_conversation", params),
      ]);
      setSummary(((sum.data as AiCostSummary[]) ?? [])[0] ?? null);
      setRows((list.data as AiCostConversationRow[]) ?? []);
    } catch {
      setSummary(null);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, windowDays, connectionId]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="mb-1 text-sm font-semibold text-foreground">{t("aiCostTitle")}</h2>
      <p className="mb-4 text-xs text-muted-foreground">{t("aiCostSubtitle", { days: windowDays })}</p>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : !summary || summary.runs === 0 ? (
        <p className="rounded-lg border border-border py-12 text-center text-sm text-muted-foreground">
          {t("aiCostEmpty")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              title={t("aiCostTotal")} value={formatUsd(summary.custo_usd)} icon={Coins}
              subtitle={t("aiCostTokens", { tokens: formatTokens(summary.tokens) })}
            />
            <MetricCard
              title={t("aiCostPerConversation")} value={formatUsd(summary.custo_medio_conversa)} icon={MessagesSquare}
              subtitle={t("aiCostConversations", { count: summary.conversas })}
            />
            <MetricCard
              title={t("aiCostRuns")} value={String(summary.runs)} icon={Bot}
              subtitle={t("aiCostCalls", { count: summary.chamadas_llm })}
            />
            <MetricCard
              title={t("aiCostHandoffs")} value={String(summary.handoffs)} icon={ArrowLeftRight}
              subtitle={t("aiCostErrors", { errors: summary.erros, noReply: summary.sem_resposta })}
            />
          </div>

          <div className="mt-4 overflow-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-muted-foreground">{t("aiCostColContact")}</TableHead>
                  <TableHead className="text-right text-muted-foreground">{t("aiCostColCost")}</TableHead>
                  <TableHead className="hidden text-right text-muted-foreground sm:table-cell">{t("aiCostColRuns")}</TableHead>
                  <TableHead className="hidden text-right text-muted-foreground md:table-cell">{t("aiCostColTokens")}</TableHead>
                  <TableHead className="hidden text-muted-foreground lg:table-cell">{t("aiCostColFlags")}</TableHead>
                  <TableHead className="hidden text-muted-foreground md:table-cell">{t("aiCostColLast")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.conversation_id}
                    className="cursor-pointer border-border hover:bg-muted/50"
                    onClick={() => void abrirConversa(r.conversation_id)}
                  >
                    <TableCell className="font-medium text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        {r.contact_name || r.contact_phone || "—"}
                        {abrindoId === r.conversation_id && (
                          <Loader2 className="size-3 animate-spin text-muted-foreground" />
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums text-foreground">
                      {formatUsd(r.custo_usd)}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
                      {r.runs}
                    </TableCell>
                    <TableCell className="hidden text-right tabular-nums text-muted-foreground md:table-cell">
                      {formatTokens(r.tokens)}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="flex items-center gap-1.5">
                        {r.handoffs > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                            <ArrowLeftRight className="size-3" />{r.handoffs}
                          </span>
                        )}
                        {r.erros > 0 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-500">
                            <AlertTriangle className="size-3" />{r.erros}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                      {formatDateTime(r.ultima_run)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* A RPC corta em 500 conversas; os cards acima seguem com o total real. */}
          {rows.length >= 500 && (
            <p className="mt-2 text-xs text-muted-foreground">{t("aiCostTruncated")}</p>
          )}
          {toNumber(summary.custo_usd) > 0 && (
            <p className="mt-2 text-xs text-muted-foreground">{t("aiCostHint")}</p>
          )}
        </>
      )}

      {/* Conversa em painel lateral: metade da tela no desktop, tela cheia no
          celular. Fechar volta pro relatório com filtro e rolagem intactos —
          por isso um sheet, e não navegação para /inbox. */}
      <Sheet open={ws.hasActiveConv} onOpenChange={(aberto) => { if (!aberto) ws.close(); }}>
        <SheetContent
          side="right"
          // Os `!` vencem o `data-[side=right]:w-3/4` e o `sm:max-w-sm` do próprio
          // sheet — seletor de atributo tem especificidade maior, e sem isso o
          // painel trava em 384px de largura e a thread fica ilegível.
          className="w-full gap-0 p-0 sm:max-w-none! lg:w-1/2!"
        >
          {/* Título exigido pelo sheet para leitor de tela; o cabeçalho visível
              da conversa vem do próprio MessageThread. */}
          <SheetTitle className="sr-only">
            {ws.activeConversation?.contact?.name ?? t("aiCostColContact")}
          </SheetTitle>
          <div className="flex h-full min-h-0 overflow-hidden">
            <ConversationWorkspace ws={ws} />
          </div>
        </SheetContent>
      </Sheet>
    </section>
  );
}
