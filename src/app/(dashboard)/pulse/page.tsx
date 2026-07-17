"use client";

// ============================================================
// Página Pulso (F1): visão executiva de atendimento + vendas.
// Admin/owner-only — gate de UI aqui (redirect) e gate REAL nas
// RPCs pulse_* (069, is_account_member admin). Espelha a estrutura
// de reports/page.tsx (filtros, Promise.all, aviso business hours).
// ============================================================
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { Activity } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveConnection } from "@/hooks/use-active-connection";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { Tiles } from "@/components/pulse/tiles";
import { Timeline } from "@/components/pulse/timeline";
import { HBars } from "@/components/pulse/hbars";
import { Radar } from "@/components/pulse/radar";
import { AgentsTable } from "@/components/pulse/agents-table";
import { resolvePulseWindow, type PulsePreset } from "@/lib/reports/pulse-params";
import type {
  AiProfilePublic, PulseTiles as PulseTilesData, PulseTimelinePoint, PulseBreakdowns, PulseRadar, ReportMember,
} from "@/types";

const PRESETS: { key: PulsePreset; labelKey: string }[] = [
  { key: "today", labelKey: "periodToday" },
  { key: "7d", labelKey: "period7d" },
  { key: "30d", labelKey: "period30d" },
  { key: "90d", labelKey: "period90d" },
  { key: "month", labelKey: "periodMonth" },
  { key: "custom", labelKey: "periodCustom" },
];

export default function PulsePage() {
  const { t } = useTranslation(["pulse", "common"]);
  const supabase = createClient();
  const router = useRouter();
  const { isOwner, profileLoading } = useAuth();
  const { activeConnectionId } = useActiveConnection();

  // Gate de UI: OWNER-only (segurança real é das RPCs, guard 071)
  useEffect(() => {
    if (!profileLoading && !isOwner) router.replace("/dashboard");
  }, [profileLoading, isOwner, router]);

  const [preset, setPreset] = useState<PulsePreset>("30d");
  const [customFrom, setCustomFrom] = useState<Date | null>(null);
  const [customTo, setCustomTo] = useState<Date | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [members, setMembers] = useState<ReportMember[]>([]);
  const [aiProfiles, setAiProfiles] = useState<AiProfilePublic[]>([]);
  const [noHours, setNoHours] = useState(false);
  const [tiles, setTiles] = useState<PulseTilesData | null>(null);
  const [prevTiles, setPrevTiles] = useState<PulseTilesData | null>(null);
  const [timeline, setTimeline] = useState<PulseTimelinePoint[]>([]);
  const [breakdowns, setBreakdowns] = useState<PulseBreakdowns | null>(null);
  const [radar, setRadar] = useState<PulseRadar | null>(null);
  const [loading, setLoading] = useState(true);

  // Dropdown de atendente (espelha reports/page.tsx:59-68)
  useEffect(() => {
    if (!isOwner) return;
    (async () => {
      const res = await fetch("/api/account/members", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { members: ReportMember[] };
      setMembers(json.members.filter((m) => m.account_role !== "viewer"));
    })();
    // Perfis de IA (view pública id/nome — o filtro das RPCs aceita o id do perfil, 072)
    (async () => {
      const { data } = await supabase.from("ai_profiles_public").select("id, nome, enabled");
      setAiProfiles(((data as AiProfilePublic[]) ?? []).filter((p) => p.enabled));
    })();
  }, [isOwner, supabase]);

  // Janela atual + anterior (delta) + endsNow (tabela por atendente)
  const win = useMemo(
    () => resolvePulseWindow(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  useEffect(() => {
    if (!win || !isOwner) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const base = { p_agent_id: selectedAgent, p_connection_id: activeConnectionId };
        const cur = { p_from: win.from.toISOString(), p_to: win.to.toISOString(), ...base };
        const prev = { p_from: win.prevFrom.toISOString(), p_to: win.prevTo.toISOString(), ...base };
        const [tc, tp, tl, bd, rd, bh] = await Promise.all([
          supabase.rpc("pulse_tiles", cur),
          supabase.rpc("pulse_tiles", prev),
          supabase.rpc("pulse_timeline", cur),
          supabase.rpc("pulse_breakdowns", cur),
          supabase.rpc("pulse_radar", base),
          // aviso 24/7: só quando há conexão ativa sem horário configurado (reports :87-89)
          activeConnectionId
            ? supabase.from("business_hours").select("id").eq("connection_id", activeConnectionId).maybeSingle()
            : Promise.resolve({ data: null, error: null }),
        ]);
        if (cancelled) return;
        setTiles(((tc.data as PulseTilesData[]) ?? [])[0] ?? null);
        setPrevTiles(((tp.data as PulseTilesData[]) ?? [])[0] ?? null);
        setTimeline((tl.data as PulseTimelinePoint[]) ?? []);
        setBreakdowns((bd.data as PulseBreakdowns | null) ?? null);
        setRadar((rd.data as PulseRadar | null) ?? null);
        setNoHours(Boolean(activeConnectionId) && !bh.data);
      } catch {
        if (!cancelled) {
          setTiles(null); setPrevTiles(null); setTimeline([]); setBreakdowns(null); setRadar(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, win, selectedAgent, activeConnectionId, isOwner]);

  // Rótulo traduzido de motivo/loss com fallback pra própria key
  const motivoLabel = (key: string) => {
    const k = `motivo_${key}`;
    const v = t(k);
    return v === k ? key : v;
  };
  const lossLabel = (key: string) => {
    const k = `loss_${key}`;
    const v = t(k);
    return v === k ? key : v;
  };

  const funil = breakdowns?.funil;

  // Filtro global aponta pro agente de IA? (id de perfil ou sentinela legado)
  const isAiSelected =
    !!selectedAgent &&
    (selectedAgent === "00000000-0000-0000-0000-0000000000a1" || aiProfiles.some((p) => p.id === selectedAgent));

  if (!profileLoading && !isOwner) return null;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Activity className="size-5 text-primary" />
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Dropdown de atendente */}
          <select
            value={selectedAgent ?? ""}
            onChange={(e) => setSelectedAgent(e.target.value || null)}
            className="rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm text-foreground"
          >
            <option value="">{t("allOperators")}</option>
            {/* Agente(s) de IA — nome do perfil (ex.: Ruth); value = id do perfil (072) */}
            {aiProfiles.map((ap) => (
              <option key={ap.id} value={ap.id}>
                🤖 {ap.nome}
              </option>
            ))}
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.full_name || m.user_id.slice(0, 8)}
              </option>
            ))}
          </select>
          {/* Presets de período */}
          <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-1">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPreset(p.key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  preset === p.key ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
          {/* Datas custom (padrão conversations/page.tsx: T00:00 = fuso local) */}
          {preset === "custom" && (
            <div className="flex items-center gap-1">
              <input
                type="date"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                onChange={(e) => setCustomFrom(e.target.value ? new Date(e.target.value + "T00:00") : null)}
              />
              <span className="text-xs text-muted-foreground">→</span>
              <input
                type="date"
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-xs text-foreground"
                onChange={(e) => setCustomTo(e.target.value ? new Date(e.target.value + "T00:00") : null)}
              />
            </div>
          )}
        </div>
      </div>

      {/* Aviso 24/7 quando a conexão ativa não tem horário configurado */}
      {noHours && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <Info className="mt-0.5 size-4 shrink-0" />
          <span>{t("noBusinessHours")}</span>
        </div>
      )}

      <Tiles current={tiles} previous={prevTiles} loading={loading} />

      <Timeline data={timeline} loading={loading} />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <HBars
          title={t("conexoesTitle")}
          rows={(breakdowns?.conexoes ?? []).map((c) => ({ label: c.name, value: c.total }))}
          emptyLabel={t("empty")}
        />
        {/* Funil comercial: 3 estágios de populações distintas (fechados pode > respondidos) */}
        <HBars
          title={t("funilTitle")}
          rows={
            funil
              ? [
                  { label: t("funilLeads"), value: funil.leads, color: "#7c3aed" },
                  { label: t("funilRespondidos"), value: funil.respondidos, color: "#3b82f6" },
                  { label: t("funilFechados"), value: funil.fechados, color: "#10b981" },
                ]
              : []
          }
          emptyLabel={t("empty")}
        />
        <HBars
          title={t("motivosTitle")}
          rows={(breakdowns?.motivos ?? []).map((m) => ({ label: motivoLabel(m.key), value: m.total, color: "#3b82f6" }))}
          emptyLabel={t("empty")}
        />
        <HBars
          title={t("lossTitle")}
          rows={(breakdowns?.loss ?? []).map((l) => ({ label: lossLabel(l.key), value: l.total, color: "#f59e0b" }))}
          emptyLabel={t("empty")}
        />
      </div>

      <Radar radar={radar} loading={loading} />

      {win && (
        <AgentsTable
          windowDays={win.windowDays}
          endsNow={win.endsNow}
          connectionId={activeConnectionId}
          members={members}
          aiName={aiProfiles[0]?.nome ?? null}
          selectedAgent={selectedAgent}
          isAiSelected={isAiSelected}
        />
      )}
    </div>
  );
}
