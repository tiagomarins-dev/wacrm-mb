"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, TrendingUp } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClassificationBadge } from "@/components/lead-score/classification-badge";
import { ContactDetailView } from "@/components/contacts/contact-detail-view";
import type { LeadScoreRow } from "@/types";

const WINDOWS = [7, 14, 30] as const;

// Formata o "último contato" de forma curta (data local) ou "—".
function fmtLast(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

// Página de ranking de leads por pontuação de engajamento. Lê a RPC
// `lead_scores` (calcula ao vivo na janela escolhida) e lista desc.
export default function LeadScorePage() {
  const supabase = createClient();
  const router = useRouter();
  const [rows, setRows] = useState<LeadScoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [windowDays, setWindowDays] = useState<number>(30);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailContactId, setDetailContactId] = useState<string | null>(null);

  const fetchScores = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc("lead_scores", {
        p_window_days: windowDays,
      });
      if (error) throw error;
      setRows((data as LeadScoreRow[]) ?? []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [supabase, windowDays]);

  useEffect(() => {
    void fetchScores();
  }, [fetchScores]);

  function openDetail(contactId: string) {
    setDetailContactId(contactId);
    setDetailOpen(true);
  }

  // Clique no lead: abre o chat dele no inbox (com a coluna de dados do
  // contato). Sem conversa ainda → cai no painel de detalhe.
  function openLead(r: LeadScoreRow) {
    if (r.conversation_id) router.push(`/inbox?c=${r.conversation_id}`);
    else openDetail(r.contact_id);
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <TrendingUp className="size-5 text-primary" />
            Lead Score
          </h1>
          <p className="text-sm text-muted-foreground">
            Ranking de leads por engajamento na janela escolhida.
          </p>
        </div>
        {/* Seletor de janela (espelha o padrão do dashboard) */}
        <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindowDays(w)}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                windowDays === w
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {w} dias
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow className="border-border hover:bg-transparent">
              <TableHead className="w-10 text-muted-foreground">#</TableHead>
              <TableHead className="text-muted-foreground">Lead</TableHead>
              <TableHead className="text-muted-foreground">Score</TableHead>
              <TableHead className="text-muted-foreground">Classificação</TableHead>
              <TableHead className="text-muted-foreground">Msgs</TableHead>
              <TableHead className="text-muted-foreground">Botões</TableHead>
              <TableHead className="text-muted-foreground">Cliques</TableHead>
              <TableHead className="text-muted-foreground">Último contato</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center">
                  <Loader2 className="mx-auto size-5 animate-spin text-primary" />
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-muted-foreground">
                  Nenhum lead com interação na janela.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((r, i) => (
                <TableRow
                  key={r.contact_id}
                  onClick={() => openLead(r)}
                  className="cursor-pointer border-border hover:bg-muted/50"
                >
                  <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                  <TableCell>
                    <div className="font-medium text-foreground">{r.name || "Sem nome"}</div>
                    <div className="font-mono text-xs text-muted-foreground">{r.phone}</div>
                  </TableCell>
                  <TableCell className="font-semibold text-foreground">{r.score}</TableCell>
                  <TableCell>
                    <ClassificationBadge value={r.classification} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.msg_count}</TableCell>
                  <TableCell className="text-muted-foreground">{r.button_count}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {r.link_count}
                    {r.sale_count > 0 ? (
                      <span className="ml-1 text-[10px] text-emerald-400">
                        ({r.sale_count} venda)
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {fmtLast(r.last_interaction_at)}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <ContactDetailView
        open={detailOpen}
        onOpenChange={setDetailOpen}
        contactId={detailContactId}
        onUpdated={fetchScores}
      />
    </div>
  );
}
