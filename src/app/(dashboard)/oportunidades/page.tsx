"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Flame, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { useAuth } from "@/hooks/use-auth";
import { useConversationWorkspace } from "@/hooks/use-conversation-workspace";
import { ConversationWorkspace } from "@/components/inbox/conversation-workspace";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClassificationBadge } from "@/components/lead-score/classification-badge";
import type { Conversation, OpportunityBucket, OpportunityFilter, OpportunityRow, OpportunitySource } from "@/types";

const PAGE = 50;
const SOURCES: OpportunitySource[] = ["all", "click", "cart"];
const FILTERS: OpportunityFilter[] = ["all", "mine", "unassigned"];
const CLASS_KEY = { quente: "Hot", morno: "Warm", frio: "Cold" } as const;

// Tela de trabalho do comercial: contatos com sinal de compra que ainda não
// compraram o curso do sinal. Lê a RPC `opportunities` (mig 087), por aba.
export default function OpportunitiesPage() {
  const { t, i18n } = useTranslation(["opportunities", "leadScore", "common"]);
  const supabase = createClient();
  const { activeConnectionId } = useActiveConnection();
  const { user, profile } = useAuth();

  const [bucket, setBucket] = useState<OpportunityBucket>("recent");
  const [source, setSource] = useState<OpportunitySource>("all");
  const [filter, setFilter] = useState<OpportunityFilter>("all");
  const [rows, setRows] = useState<OpportunityRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasCartData, setHasCartData] = useState(true);
  // Conversas abertas pelo painel (a lista da tela é de contatos, não de conversas).
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);

  // Motor da conversa compartilhado com inbox e /conversations: abre a conversa
  // à direita sem sair da tela. Conversa fora das abertas aqui é ignorada.
  const ws = useConversationWorkspace({
    channelName: "opportunities-realtime",
    conversations: convs,
    patchConversation: (id, updater) => setConvs((prev) => prev.map((c) => (c.id === id ? updater(c) : c))),
    upsertConversation: () => {},
    removeConversation: (id) => setConvs((prev) => prev.filter((c) => c.id !== id)),
  });

  const activeConvId = ws.activeConversation?.id ?? null;

  // Resposta humana dada pelo painel marca a linha como abordada na hora, sem
  // recarregar a lista: recarregar voltaria à 1ª página e perderia a rolagem. A
  // ordem (abordados no fim) só é aplicada na próxima busca.
  useEffect(() => {
    if (!activeConvId) return;
    // Mensagem otimista (temp-) ainda pode falhar no envio: só a gravada conta.
    const lastHuman = [...ws.messages].reverse().find((m) => m.sender_type === "agent" && !m.id.startsWith("temp-"));
    if (!lastHuman) return;
    const sentAt = Date.parse(lastHuman.created_at);
     
    setRows((prev) =>
      prev.map((r) => {
        if (r.conversation_id !== activeConvId) return r;
        if (sentAt <= Date.parse(r.signal_at)) return r;
        if (r.approached_at && sentAt <= Date.parse(r.approached_at)) return r;
        const byMe = lastHuman.sender_id === user?.id;
        return {
          ...r,
          approached_at: lastHuman.created_at,
          approached_by_name: byMe ? (profile?.full_name ?? null) : r.approached_by_name,
        };
      }),
    );
  }, [ws.messages, activeConvId, user?.id, profile?.full_name]);

  // Busca a conversa com o contato (ws.select alimenta a sidebar a partir de
  // conv.contact) e abre no painel.
  async function openConversation(convId: string) {
    if (convId === activeConvId || openingId) return;
    setOpeningId(convId);
    try {
      const { data, error } = await supabase
        .from("conversations")
        .select("*, contact:contacts(*)")
        .eq("id", convId)
        .maybeSingle();
      if (error || !data) {
        toast.error(t("openConversationError"));
        return;
      }
      const conv = data as Conversation;
      setConvs((prev) => [conv, ...prev.filter((c) => c.id !== conv.id)]);
      ws.select(conv);
    } finally {
      setOpeningId(null);
    }
  }

  const dateLocale = i18n.language === "pt-BR" ? ptBR : undefined;

  // Busca uma página; offset 0 substitui a lista, >0 acrescenta ("Carregar mais").
  const fetchPage = useCallback(
    async (offset: number) => {
      const { data, error } = await supabase.rpc("opportunities", {
        p_bucket: bucket,
        p_source: source,
        p_connection_id: activeConnectionId,
        p_filter: filter,
        p_limit: PAGE,
        p_offset: offset,
      });
      if (error) throw error;
      return (data as OpportunityRow[]) ?? [];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bucket, source, filter, activeConnectionId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const page = await fetchPage(0);
        if (cancelled) return;
        setRows(page);
        setTotal(page[0]?.total_count ?? 0);
        // aviso de integração só faz sentido no filtro de carrinho
        if (source === "cart") {
          const { data } = await supabase.rpc("opportunities_has_cart_data");
          if (!cancelled) setHasCartData(Boolean(data));
        }
      } catch {
        if (!cancelled) {
          setRows([]);
          setTotal(0);
          toast.error(t("loadError"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPage]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await fetchPage(rows.length);
      setRows((prev) => [...prev, ...page]);
    } catch {
      toast.error(t("loadError"));
    } finally {
      setLoadingMore(false);
    }
  }

  const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true, locale: dateLocale });

  // Chips de sinal: clique (com contagem), carrinho e "vai decidir"/"preço" (fraco).
  function signalChips(r: OpportunityRow) {
    return (
      <div className="flex flex-wrap gap-1">
        {r.signal_types.includes("click") && (
          <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-medium">
            {t("signalClick", { count: r.click_count })}
          </span>
        )}
        {r.signal_types.includes("cart") && (
          <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-400">
            {t("signalCart")}
          </span>
        )}
        {r.signal_types.includes("intent") && (
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium">
            {t(r.loss_reason === "preco" ? "signalPrice" : "signalDecide")} · {t("weakSignal")}
          </span>
        )}
      </div>
    );
  }

  // Filtro segmentado (mesmo visual do seletor de janela em reports/page.tsx).
  function segmented<T extends string>(values: T[], current: T, set: (v: T) => void, key: string) {
    return (
      <div className="bg-muted/60 flex items-center gap-1 rounded-lg p-1">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => set(v)}
            className={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              current === v ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`${key}_${v}`)}
          </button>
        ))}
      </div>
    );
  }

  const showCartNotice = source === "cart" && !hasCartData;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Split: lista (esq) ↔ conversa+contato (dir), mesmo layout de /conversations. */}
      <div className="flex flex-1 overflow-hidden">
        {/* Painel esquerdo rola sozinho; some no mobile com a conversa aberta. */}
        <div
          className={cn(
            "h-full min-w-0 flex-1 overflow-y-auto p-4 sm:p-6",
            ws.hasActiveConv ? "hidden lg:block" : "block",
          )}
        >
          <div className="mx-auto max-w-6xl space-y-4">
            <div>
              <h1 className="text-foreground flex items-center gap-2 text-xl font-semibold">
                <Flame className="text-primary size-5" />
                {t("title")}
              </h1>
              <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <Tabs value={bucket} onValueChange={(v) => setBucket(v as OpportunityBucket)}>
                <TabsList variant="line">
                  <TabsTrigger value="recent">{t("tabRecent")}</TabsTrigger>
                  <TabsTrigger value="old">{t("tabOld")}</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex flex-wrap items-center gap-2">
                {segmented(SOURCES, source, setSource, "source")}
                {segmented(FILTERS, filter, setFilter, "filter")}
              </div>
            </div>

            <p className="text-muted-foreground text-xs">{t("totalCount", { count: total })}</p>

            <div className="border-border overflow-hidden rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow className="border-border hover:bg-transparent">
                    <TableHead className="text-muted-foreground">{t("colContact")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("colCourse")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("colSignal")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("colWhen")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("colScore")}</TableHead>
                    <TableHead className="text-muted-foreground">{t("colStatus")}</TableHead>
                    <TableHead className="w-32" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center">
                        <Loader2 className="text-primary mx-auto size-5 animate-spin" />
                      </TableCell>
                    </TableRow>
                  ) : rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={7} className="text-muted-foreground py-10 text-center text-sm">
                        {showCartNotice ? t("cartNotConfigured") : t("empty")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r) => (
                      <TableRow
                        key={r.contact_id}
                        className={cn(
                          "border-border",
                          r.conversation_id && "hover:bg-muted/50 cursor-pointer",
                          activeConvId && activeConvId === r.conversation_id && "border-l-primary bg-muted/70 border-l-2",
                        )}
                        onClick={() => r.conversation_id && openConversation(r.conversation_id)}
                      >
                        <TableCell>
                          <div className="text-foreground font-medium">{r.name || t("leadScore:unnamed")}</div>
                          <div className="text-muted-foreground font-mono text-xs">{r.phone}</div>
                        </TableCell>
                        <TableCell className="text-sm">{r.course_name ?? t("courseUnknown")}</TableCell>
                        <TableCell>{signalChips(r)}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{ago(r.signal_at)}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="text-foreground font-semibold">{r.score}</span>
                            <ClassificationBadge
                              value={r.classification}
                              label={t(`leadScore:classification${CLASS_KEY[r.classification]}`)}
                            />
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 text-[10px]">
                            {r.is_student_other_course && (
                              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-400">
                                {t("badgeStudent")}
                              </span>
                            )}
                            {r.approached_at && (
                              <span className="text-muted-foreground rounded-full bg-slate-500/10 px-2 py-0.5 font-medium">
                                {r.approached_by_name
                                  ? t("badgeApproachedBy", {
                                      when: ago(r.approached_at),
                                      name: r.approached_by_name,
                                    })
                                  : t("badgeApproached", {
                                      when: ago(r.approached_at),
                                    })}
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            size="sm"
                            variant={activeConvId && activeConvId === r.conversation_id ? "secondary" : "outline"}
                            disabled={!r.conversation_id || openingId === r.conversation_id}
                            onClick={(e) => {
                              // a linha também abre: sem isso o clique buscaria a conversa duas vezes
                              e.stopPropagation();
                              if (r.conversation_id) openConversation(r.conversation_id);
                            }}
                          >
                            {openingId === r.conversation_id && <Loader2 className="size-4 animate-spin" />}
                            {t("openConversation")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {!loading && rows.length < total && (
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore && <Loader2 className="size-4 animate-spin" />}
                  {t("loadMore")}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Painel direito só com conversa aberta: a lista fica cheia enquanto nada
            está selecionado. O "voltar" (desktop) fecha a conversa. */}
        {ws.hasActiveConv && <ConversationWorkspace ws={ws} showDesktopBack />}
      </div>
    </div>
  );
}
