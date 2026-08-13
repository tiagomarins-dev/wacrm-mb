"use client";

// ============================================================
// Playground da Ruth — chat de teste do agente de IA sem WhatsApp.
//
// Tudo vive em memória do React (senha, config, histórico): F5 = conversa
// nova, por requisito. Cada turno manda o histórico COMPLETO pra
// /api/playground-ruth/chat, que roda o motor real em modo zero-escrita.
// Os prompts são rascunhos locais — editar aqui NÃO altera ai_profiles.
// ============================================================

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// Mesmo cap da rota /chat — precisa comportar a persona de produção (~20.300).
const MAX_PROMPT_CHARS = 30000;

// Modelos sugeridos p/ o select — ranking de fontes de ago/2026 (BenchLM,
// gurusup, tech-insider) cruzado com preço live e suporte a tools no
// OpenRouter. Custo estimado por 1.000 conversas (5 turnos de ~12k in/300 out).
const MODEL_OPTIONS: { id: string; label: string }[] = [
  { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6 — atual · $203/1k conversas" },
  { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini — 1º p/ atendimento · $52/1k" },
  { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5 — default seguro · $68/1k" },
  { id: "google/gemini-3.6-flash", label: "Gemini 3.6 Flash — melhor do tier budget · $101/1k" },
  { id: "google/gemini-3.5-flash", label: "Gemini 3.5 Flash — ctx 1M · $104/1k" },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash — geração anterior, provada · $22/1k" },
  { id: "openai/gpt-5-mini", label: "GPT-5 Mini — geração anterior · $18/1k" },
  { id: "google/gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite — eficiente · $22/1k" },
  { id: "minimax/minimax-m3", label: "MiniMax M3 — melhor open budget · $20/1k" },
  { id: "minimax/minimax-m2.7", label: "MiniMax M2.7 — open budget · $20/1k" },
  { id: "google/gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite — econômico · $17/1k" },
  { id: "deepseek/deepseek-v3.2", label: "DeepSeek V3.2 — open forte · $17/1k" },
  { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano — ultra-barato · $14/1k" },
  { id: "openai/gpt-4o-mini", label: "GPT-4o Mini — veterano confiável · $10/1k" },
  { id: "qwen/qwen3-235b-a22b-2507", label: "Qwen3 235B — MoE grande · $6/1k" },
  { id: "mistralai/mistral-small-3.2-24b-instruct", label: "Mistral Small 3.2 — ultra-econômico · $6/1k" },
  { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B — ultra-econômico · $6/1k" },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna — mais barato c/ tools · $7/1k" },
];
const CUSTOM_MODEL = "__custom__";

type Profile = {
  id: string;
  nome: string;
  slug: string | null;
  enabled: boolean;
  persona_prompt: string | null;
  opening_prompt: string | null;
  model: string;
  allowed_tools: string[] | null;
  max_bot_turns: number;
};

type LeadMatch = {
  contactId: string;
  name: string | null;
  phoneLast4: string;
  hasLeadContext: boolean;
  leadContextKeys: string[];
};

type Course = {
  slug: string;
  nome: string;
  ativo: boolean;
  posicionamento: string | null;
  condicao_vigente: string | null;
  tem_link: boolean;
};

// Rascunho editável da ficha (por slug) — vale só pra conversa de teste.
type CourseDraft = { posicionamento: string; condicao_vigente: string };

// Heurística de exibição: curso com condição de matrícula fechada ganha badge
// vermelho — espelha o que o RASCUNHO diz, sem interpretar além do texto.
function cursoFechado(draft: CourseDraft): boolean {
  const texto = `${draft.condicao_vigente} ${draft.posicionamento}`.toLowerCase();
  return texto.includes("encerrad") || texto.includes("fechad");
}

// Formato do arquivo de backup/versão da configuração do playground.
// Só rascunhos — nada aqui toca o banco; importar repõe os campos da tela.
type ConfigExport = {
  formato: "playground-ruth-config";
  versao: 1;
  exportado_em: string;
  perfil: { id: string; nome: string; slug: string | null };
  personaPrompt: string;
  openingPrompt: string;
  courseDrafts: Record<string, CourseDraft>;
  // Contexto da campanha (opcional): ação alvo + resumo do template enviado.
  // Vai pro prompt como bloco <contexto_da_campanha> anexado à persona.
  campaignContext?: string;
  // Modelo (opcional): override de id OpenRouter usado nos testes.
  model?: string;
};

type Telemetry = {
  requests: number;
  turns: number;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  llmMs: number;
  finishReason: string | null;
  toolsUsed: string[];
  error: { phase: string; message: string } | null;
};

type TurnEvents = {
  handoff: { to: string | null } | null;
  handoffSuppressed: boolean;
  encerrar: boolean;
  linkDryRun: boolean;
};

// Uma entrada do chat: bolha de mensagem ou chip de evento do turno.
type ChatItem =
  | { kind: "bubble"; role: "user" | "assistant"; text: string }
  | { kind: "event"; text: string }
  | { kind: "error"; text: string };

type HistoryMsg = { role: "user" | "assistant"; content: string };

export default function PlaygroundRuthPage() {
  // Auth + perfis (senha só em state — nunca localStorage).
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  const [courses, setCourses] = useState<Course[]>([]);
  const [courseDrafts, setCourseDrafts] = useState<Record<string, CourseDraft>>({});
  const [coursesOpen, setCoursesOpen] = useState(false);

  // Rascunhos de prompt (editar não salva no banco).
  const [personaDraft, setPersonaDraft] = useState("");
  const [openingDraft, setOpeningDraft] = useState("");
  // Campanha: ação alvo + resumo do template que o lead recebeu/clicou.
  const [campaignDraft, setCampaignDraft] = useState("");
  // Modelo (id OpenRouter): rascunho — override só nesta sessão de teste.
  const [modelDraft, setModelDraft] = useState("");
  const [configOpen, setConfigOpen] = useState(true);

  // Simular ativo (lookup por sufixo do telefone).
  const [simulateActive, setSimulateActive] = useState(false);
  const [phoneSuffix, setPhoneSuffix] = useState("");
  const [matches, setMatches] = useState<LeadMatch[]>([]);
  const [selectedContact, setSelectedContact] = useState<LeadMatch | null>(null);

  // Conversa (memória apenas).
  const [items, setItems] = useState<ChatItem[]>([]);
  const [history, setHistory] = useState<HistoryMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [lastTelemetry, setLastTelemetry] = useState<Telemetry | null>(null);
  const [totals, setTotals] = useState({ turns: 0, tokens: 0, costUsd: 0, llmMs: 0 });
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items]);

  const profile = profiles.find((p) => p.id === profileId) ?? null;

  // Headers de toda chamada — a senha vai por header, nunca por URL.
  const authHeaders = { "Content-Type": "application/json", "x-playground-password": password };

  // Busca perfis + base de cursos e REPÕE todos os rascunhos com o que está
  // no banco agora. Usada no login e no botão "Puxar do banco".
  // keepProfileId: mantém o perfil selecionado quando ele ainda existir.
  const fetchFromBank = async (keepProfileId?: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/playground-ruth/profiles", { headers: authHeaders });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) {
        toast.error("Playground não configurado (env ausente no servidor)");
        return false;
      }
      if (res.status === 401) {
        toast.error("Senha incorreta");
        return false;
      }
      if (res.status === 429) {
        toast.error("Muitas tentativas — aguarde um minuto");
        return false;
      }
      if (!res.ok) {
        toast.error(data?.error || "Falha ao buscar do banco");
        return false;
      }
      const list = (data.profiles ?? []) as Profile[];
      if (list.length === 0) {
        toast.error("Nenhum perfil de IA cadastrado");
        return false;
      }
      setProfiles(list);
      const cursos = (data.courses ?? []) as Course[];
      setCourses(cursos);
      // Rascunhos partem da ficha real; editar não salva no banco.
      setCourseDrafts(
        Object.fromEntries(
          cursos.map((c) => [
            c.slug,
            { posicionamento: c.posicionamento ?? "", condicao_vigente: c.condicao_vigente ?? "" },
          ]),
        ),
      );
      const alvo = list.find((p) => p.id === keepProfileId) ?? list[0];
      selectProfile(alvo);
      return true;
    } catch {
      toast.error("Falha de rede");
      return false;
    }
  };

  // Login = primeiro GET /profiles com a senha; 200 destrava a página.
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await fetchFromBank()) setAuthed(true);
  };

  // "Puxar do banco": substitui TODOS os rascunhos (prompts + cursos) pelos
  // dados atuais do banco. Confirma antes se houver edição local pendente.
  const handlePullFromBank = async () => {
    const cursoEditado = courses.some((c) => {
      const d = courseDrafts[c.slug];
      return (
        d &&
        (d.posicionamento !== (c.posicionamento ?? "") || d.condicao_vigente !== (c.condicao_vigente ?? ""))
      );
    });
    const promptEditado =
      !!profile &&
      (personaDraft !== (profile.persona_prompt ?? "") || openingDraft !== (profile.opening_prompt ?? ""));
    if (
      (cursoEditado || promptEditado) &&
      !window.confirm("Você tem edições não exportadas. Substituir tudo pelos dados do banco?")
    ) {
      return;
    }
    if (await fetchFromBank(profileId)) {
      toast.success("Rascunhos atualizados com os dados atuais do banco");
    }
  };

  // Trocar de perfil repõe os rascunhos com os prompts atuais do banco.
  const selectProfile = (p: Profile) => {
    setProfileId(p.id);
    setPersonaDraft(p.persona_prompt ?? "");
    setOpeningDraft(p.opening_prompt ?? "");
    setModelDraft(p.model);
  };

  const handleLookup = async () => {
    const digits = phoneSuffix.replace(/\D/g, "");
    if (digits.length < 4) return toast.error("Digite pelo menos 4 dígitos do telefone");
    try {
      const res = await fetch("/api/playground-ruth/lead-lookup", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ profileId, phoneSuffix: digits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast.error(data?.error || "Falha na busca");
      const found = (data.matches ?? []) as LeadMatch[];
      setMatches(found);
      setSelectedContact(null);
      if (found.length === 0) toast.info("Nenhum contato com esse final de telefone");
    } catch {
      toast.error("Falha de rede");
    }
  };

  // Envia um turno: histórico completo + config atual. `opening` liga na
  // primeira resposta do modo ativo (nenhuma msg da Ruth ainda).
  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || sending || !profile) return;
    // Simular ativo sem lead selecionado = teste sem sentido (a graça é o
    // contexto da pesquisa) — bloqueia com aviso em vez de mandar sem contexto.
    if (simulateActive && !selectedContact) {
      toast.error("Selecione um lead da busca antes de enviar (clique no card do contato)");
      return;
    }
    const opening = simulateActive && !history.some((m) => m.role === "assistant");
    // Só manda override do que realmente divergiu da ficha original.
    const courseOverrides: Record<string, { posicionamento?: string | null; condicao_vigente?: string | null }> = {};
    for (const c of courses) {
      const draft = courseDrafts[c.slug];
      if (!draft) continue;
      const ov: { posicionamento?: string | null; condicao_vigente?: string | null } = {};
      if (draft.posicionamento !== (c.posicionamento ?? "")) ov.posicionamento = draft.posicionamento || null;
      if (draft.condicao_vigente !== (c.condicao_vigente ?? "")) ov.condicao_vigente = draft.condicao_vigente || null;
      if (Object.keys(ov).length > 0) courseOverrides[c.slug] = ov;
    }
    const newHistory: HistoryMsg[] = [...history, { role: "user", content: text }];
    setHistory(newHistory);
    setItems((prev) => [...prev, { kind: "bubble", role: "user", text }]);
    setDraft("");
    setSending(true);
    try {
      const res = await fetch("/api/playground-ruth/chat", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          profileId,
          personaPrompt: personaDraft,
          // Campanha vai como campo próprio: o servidor monta o mesmo bloco
          // <contexto da campanha> que a produção usa (081), em vez de a página
          // concatenar na persona — assim o teste reflete o prompt real.
          campaignContext: campaignDraft.trim() || null,
          openingPrompt: openingDraft.trim() ? openingDraft : null,
          ...(profile && modelDraft.trim() && modelDraft !== profile.model
            ? { model: modelDraft.trim() }
            : {}),
          opening,
          contactId: simulateActive ? (selectedContact?.contactId ?? null) : null,
          messages: newHistory,
          ...(Object.keys(courseOverrides).length > 0 ? { courseOverrides } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setItems((prev) => [...prev, { kind: "error", text: data?.error || `Erro ${res.status}` }]);
        return;
      }
      const bubbles = (data.bubbles ?? []) as string[];
      const events = data.events as TurnEvents;
      const telemetry = data.telemetry as Telemetry;
      // O reply inteiro entra UMA vez no histórico (1 turno assistant); as
      // bolhas são só apresentação, como no WhatsApp.
      if (data.reply) setHistory((prev) => [...prev, { role: "assistant", content: data.reply }]);
      setItems((prev) => {
        const next = [...prev];
        for (const b of bubbles) next.push({ kind: "bubble", role: "assistant", text: b });
        if (events.linkDryRun) next.push({ kind: "event", text: "🔗 link em modo dry (nenhum token criado)" });
        if (events.handoffSuppressed) next.push({ kind: "event", text: "🤝 handoff suprimido (abertura)" });
        else if (events.handoff) next.push({ kind: "event", text: "🤝 transferiu para humano" });
        if (events.encerrar) next.push({ kind: "event", text: "👋 encerrou o turno sem mensagem" });
        if (telemetry?.error) next.push({ kind: "error", text: `Erro do LLM: ${telemetry.error.message}` });
        return next;
      });
      if (telemetry) {
        setLastTelemetry(telemetry);
        setTotals((t) => ({
          turns: t.turns + 1,
          tokens: t.tokens + (telemetry.totalTokens ?? 0),
          costUsd: t.costUsd + (telemetry.costUsd ?? 0),
          llmMs: t.llmMs + telemetry.llmMs,
        }));
      }
    } catch {
      setItems((prev) => [...prev, { kind: "error", text: "Falha de rede" }]);
    } finally {
      setSending(false);
    }
  };

  const handleNewConversation = () => {
    setItems([]);
    setHistory([]);
    setLastTelemetry(null);
  };

  // Exporta a configuração atual (rascunhos) como arquivo JSON — backup e
  // versionamento das mudanças de prompt ficam por conta do usuário.
  const handleExport = () => {
    if (!profile) return;
    const data: ConfigExport = {
      formato: "playground-ruth-config",
      versao: 1,
      exportado_em: new Date().toISOString(),
      perfil: { id: profile.id, nome: profile.nome, slug: profile.slug },
      personaPrompt: personaDraft,
      openingPrompt: openingDraft,
      courseDrafts,
      ...(campaignDraft.trim() ? { campaignContext: campaignDraft } : {}),
      ...(profile && modelDraft.trim() && modelDraft !== profile.model ? { model: modelDraft.trim() } : {}),
    };
    // Carimbo em hora LOCAL (nome de arquivo é pra humano versionar).
    const agora = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    const stamp = `${agora.getFullYear()}-${p2(agora.getMonth() + 1)}-${p2(agora.getDate())}-${p2(agora.getHours())}${p2(agora.getMinutes())}`;
    const nome = `playground-ruth-${profile.slug ?? profile.id.slice(0, 8)}-${stamp}.json`;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nome;
    a.click();
    URL.revokeObjectURL(url);
    toast.success(`Exportado: ${nome}`);
  };

  // Importa um JSON exportado antes e repõe os rascunhos da tela (nada vai
  // pro banco). Cursos que não existem mais na base são ignorados com aviso.
  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permite importar o mesmo arquivo de novo
    if (!file) return;
    try {
      const data = JSON.parse(await file.text()) as Partial<ConfigExport>;
      if (data.formato !== "playground-ruth-config") {
        return toast.error("Arquivo não é uma configuração do playground");
      }
      if (typeof data.personaPrompt === "string") setPersonaDraft(data.personaPrompt);
      if (typeof data.openingPrompt === "string") setOpeningDraft(data.openingPrompt);
      if (typeof data.campaignContext === "string") setCampaignDraft(data.campaignContext);
      if (typeof data.model === "string" && data.model.trim()) setModelDraft(data.model.trim());
      if (data.courseDrafts && typeof data.courseDrafts === "object") {
        const conhecidos = new Set(courses.map((c) => c.slug));
        const ignorados: string[] = [];
        setCourseDrafts((atual) => {
          const next = { ...atual };
          for (const [slug, draft] of Object.entries(data.courseDrafts!)) {
            if (!conhecidos.has(slug)) {
              ignorados.push(slug);
              continue;
            }
            next[slug] = {
              posicionamento: String(draft?.posicionamento ?? ""),
              condicao_vigente: String(draft?.condicao_vigente ?? ""),
            };
          }
          return next;
        });
        if (ignorados.length > 0) toast.info(`Cursos ignorados (não existem mais): ${ignorados.join(", ")}`);
      }
      if (data.perfil?.id && data.perfil.id !== profileId) {
        toast.info(`Config exportada do perfil "${data.perfil.nome}" — prompts aplicados no perfil atual`);
      }
      toast.success("Configuração importada (rascunhos da tela — nada foi salvo no banco)");
    } catch {
      toast.error("Falha ao ler o arquivo JSON");
    }
  };

  // ---------- Tela de senha ----------
  if (!authed) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="text-center">
            <CardTitle className="text-xl text-foreground">Playground da Ruth</CardTitle>
            <p className="text-sm text-muted-foreground">
              Ambiente de teste do agente. Nada é enviado ao WhatsApp nem gravado.
            </p>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleLogin} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="pg-password" className="text-muted-foreground">Senha</Label>
                <Input
                  id="pg-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                />
              </div>
              <Button type="submit" disabled={!password}>Entrar</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---------- Playground ----------
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-4">
      {/* Config */}
      <Card className="border-border bg-card">
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <CardTitle className="text-base text-foreground">Configuração</CardTitle>
          <div className="flex items-center gap-1">
            {/* Recarrega prompts + base de cursos do banco, substituindo os
                rascunhos da tela (com confirmação se houver edição pendente). */}
            <Button variant="ghost" size="sm" onClick={handlePullFromBank}>
              Puxar do banco
            </Button>
            {/* Backup/versão dos rascunhos em JSON — exporta e importa só o
                que está na tela; o banco nunca é tocado por aqui. */}
            <Button variant="ghost" size="sm" onClick={handleExport}>
              Exportar JSON
            </Button>
            <label className="cursor-pointer rounded-md px-3 py-1.5 text-sm text-foreground hover:bg-muted">
              Importar
              <input type="file" accept="application/json,.json" className="hidden" onChange={handleImport} />
            </label>
            <Button variant="ghost" size="sm" onClick={() => setConfigOpen((v) => !v)}>
              {configOpen ? "Recolher" : "Expandir"}
            </Button>
          </div>
        </CardHeader>
        {configOpen && (
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">Perfil</Label>
              <div className="flex flex-wrap gap-2">
                {profiles.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectProfile(p)}
                    className={cn(
                      "rounded-lg border px-3 py-1.5 text-sm",
                      p.id === profileId
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border bg-card-2 text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {p.nome}
                    {!p.enabled && (
                      <span className="ml-2 rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-400">
                        desabilitado
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">
                Modelo (id OpenRouter — rascunho, não salva no perfil)
                {profile && modelDraft !== profile.model && (
                  <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">override</span>
                )}
              </Label>
              <div className="flex gap-2">
                {/* Select nativo com o ranking; "digitar outro id" libera o campo
                    livre pra qualquer modelo do OpenRouter. */}
                <select
                  value={MODEL_OPTIONS.some((o) => o.id === modelDraft) ? modelDraft : CUSTOM_MODEL}
                  onChange={(e) => {
                    if (e.target.value !== CUSTOM_MODEL) setModelDraft(e.target.value);
                    else setModelDraft("");
                  }}
                  className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-xs text-foreground outline-none focus-visible:border-ring"
                >
                  {MODEL_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                  <option value={CUSTOM_MODEL}>— digitar outro id do OpenRouter —</option>
                </select>
                {profile && modelDraft !== profile.model && (
                  <Button type="button" variant="secondary" onClick={() => setModelDraft(profile.model)}>
                    Restaurar
                  </Button>
                )}
              </div>
              {!MODEL_OPTIONS.some((o) => o.id === modelDraft) && (
                <Input
                  value={modelDraft}
                  onChange={(e) => setModelDraft(e.target.value)}
                  className="font-mono text-xs"
                  placeholder="vendor/modelo (id do OpenRouter)"
                  autoFocus
                />
              )}
              {profile && (
                <p className="text-xs text-muted-foreground">
                  perfil usa {profile.model} · máx. {profile.max_bot_turns} turns
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">
                Persona (rascunho — não salva no perfil) · {personaDraft.length.toLocaleString("pt-BR")}/{MAX_PROMPT_CHARS.toLocaleString("pt-BR")}
              </Label>
              {/* max-h + overflow: o campo autodimensiona (field-sizing-content)
                  e a persona tem >20k chars — sem teto, a página vira um scroll
                  de milhares de pixels. */}
              <Textarea
                value={personaDraft}
                onChange={(e) => setPersonaDraft(e.target.value)}
                maxLength={MAX_PROMPT_CHARS}
                rows={6}
                className="max-h-72 overflow-y-auto font-mono text-xs"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">
                Opening prompt (abertura do contato ativo) · {openingDraft.length.toLocaleString("pt-BR")}/{MAX_PROMPT_CHARS.toLocaleString("pt-BR")}
              </Label>
              <Textarea
                value={openingDraft}
                onChange={(e) => setOpeningDraft(e.target.value)}
                maxLength={MAX_PROMPT_CHARS}
                rows={3}
                className="max-h-48 overflow-y-auto font-mono text-xs"
                placeholder="Vazio = abertura padrão do motor"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label className="text-muted-foreground">
                Contexto da campanha (ação alvo + template enviado) · {campaignDraft.length}/2.000
              </Label>
              <Textarea
                value={campaignDraft}
                onChange={(e) => setCampaignDraft(e.target.value)}
                maxLength={2000}
                rows={3}
                className="max-h-40 overflow-y-auto text-xs"
                placeholder={'Ex.: Ação: oferecer o curso de ENEM (Método Blindado Intensivo).\nTemplate enviado: "Oferta especial para o fechamento da turma..." com botão "Saiba mais".'}
              />
              <p className="text-xs text-muted-foreground">
                Entra no prompt como bloco interno durante a conversa toda. Troque aqui pra reusar a mesma config em outra campanha (UERJ etc.).
              </p>
            </div>

            {/* Base de cursos: o que a Ruth enxerga (posicionamento entra no
                catálogo do prompt; a condição via tool get_curso). Os campos são
                RASCUNHOS locais — a conversa de teste usa o texto editado, mas o
                banco só muda em Configurações → Agente de IA → Cursos. */}
            <div className="flex flex-col gap-2 rounded-lg border border-border bg-card-2 p-3">
              <button
                type="button"
                onClick={() => setCoursesOpen((v) => !v)}
                className="flex items-center justify-between text-left text-sm text-foreground"
              >
                <span>Base de cursos (rascunho — não salva no banco) · {courses.length}</span>
                <span className="text-muted-foreground">{coursesOpen ? "▲" : "▼"}</span>
              </button>
              {coursesOpen && (
                <div className="flex flex-col gap-2">
                  {courses.map((c) => {
                    const draft = courseDrafts[c.slug] ?? { posicionamento: "", condicao_vigente: "" };
                    const editado =
                      draft.posicionamento !== (c.posicionamento ?? "") ||
                      draft.condicao_vigente !== (c.condicao_vigente ?? "");
                    return (
                      <div key={c.slug} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-foreground">{c.nome}</span>
                          {cursoFechado(draft) ? (
                            <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-red-400">fechado</span>
                          ) : (
                            <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-emerald-400">aberto</span>
                          )}
                          {!c.ativo && (
                            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-400">
                              inativo (fora do catálogo)
                            </span>
                          )}
                          {!c.tem_link && <span className="text-muted-foreground">sem link de venda</span>}
                          {editado && (
                            <>
                              <span className="rounded bg-primary/15 px-1.5 py-0.5 text-primary">editado</span>
                              <button
                                type="button"
                                className="text-muted-foreground underline hover:text-foreground"
                                onClick={() =>
                                  setCourseDrafts((d) => ({
                                    ...d,
                                    [c.slug]: {
                                      posicionamento: c.posicionamento ?? "",
                                      condicao_vigente: c.condicao_vigente ?? "",
                                    },
                                  }))
                                }
                              >
                                restaurar
                              </button>
                            </>
                          )}
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-foreground/70">Condição vigente</span>
                          <Textarea
                            value={draft.condicao_vigente}
                            onChange={(e) =>
                              setCourseDrafts((d) => ({
                                ...d,
                                [c.slug]: { ...draft, condicao_vigente: e.target.value },
                              }))
                            }
                            maxLength={4000}
                            rows={2}
                            className="max-h-32 overflow-y-auto text-xs"
                          />
                        </div>
                        <div className="flex flex-col gap-1">
                          <span className="text-foreground/70">Posicionamento (entra no catálogo do prompt)</span>
                          <Textarea
                            value={draft.posicionamento}
                            onChange={(e) =>
                              setCourseDrafts((d) => ({
                                ...d,
                                [c.slug]: { ...draft, posicionamento: e.target.value },
                              }))
                            }
                            maxLength={4000}
                            rows={3}
                            className="max-h-32 overflow-y-auto text-xs"
                          />
                        </div>
                      </div>
                    );
                  })}
                  <p className="text-xs text-muted-foreground">
                    Editar aqui afeta só esta conversa de teste. O banco real muda em Configurações → Agente de IA → Cursos.
                  </p>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card-2 p-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="simulate-active"
                  checked={simulateActive}
                  onCheckedChange={(v) => {
                    setSimulateActive(v === true);
                    if (v !== true) { setSelectedContact(null); setMatches([]); }
                  }}
                />
                <Label htmlFor="simulate-active" className="text-foreground">
                  Simular ativo (injeta a pesquisa do lead e abre em modo opening)
                </Label>
              </div>
              {simulateActive && (
                <>
                  <div className="flex gap-2">
                    <Input
                      value={phoneSuffix}
                      onChange={(e) => setPhoneSuffix(e.target.value)}
                      placeholder="Últimos dígitos do telefone (mín. 4)"
                      inputMode="numeric"
                    />
                    <Button type="button" variant="secondary" onClick={handleLookup}>
                      Buscar lead
                    </Button>
                  </div>
                  {matches.length > 0 && (
                    <div className="flex flex-col gap-2">
                      {matches.map((m) => (
                        <button
                          key={m.contactId}
                          type="button"
                          onClick={() => setSelectedContact(m)}
                          className={cn(
                            "flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm",
                            selectedContact?.contactId === m.contactId
                              ? "border-primary bg-primary/10"
                              : "border-border hover:bg-card",
                          )}
                        >
                          <span className="text-foreground">{m.name ?? "(sem nome)"}</span>
                          <span className="text-muted-foreground">****{m.phoneLast4}</span>
                          {m.hasLeadContext ? (
                            m.leadContextKeys.map((k) => (
                              <span key={k} className="rounded bg-primary/15 px-1.5 py-0.5 text-xs text-primary">
                                {k}
                              </span>
                            ))
                          ) : (
                            <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-400">
                              sem pesquisa
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                  {selectedContact && (
                    <p className="text-xs text-muted-foreground">
                      Lead selecionado: {selectedContact.name ?? "(sem nome)"} ****{selectedContact.phoneLast4}.
                      Digite a frase-gatilho no chat pra Ruth abrir a conversa.
                    </p>
                  )}
                </>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      {/* Chat */}
      <Card className="flex min-h-[50vh] flex-1 flex-col border-border bg-card">
        <CardContent className="flex flex-1 flex-col gap-2 overflow-y-auto p-4">
          {items.length === 0 && (
            <p className="m-auto text-sm text-muted-foreground">
              {simulateActive
                ? "Digite a frase-gatilho da automação pra começar."
                : "Digite como se fosse o cliente chegando no WhatsApp."}
            </p>
          )}
          {items.map((item, i) =>
            item.kind === "bubble" ? (
              <div key={i} className={cn("flex flex-col", item.role === "assistant" ? "items-end" : "items-start")}>
                <div
                  className={cn(
                    "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm",
                    item.role === "assistant"
                      ? "rounded-br-md bg-bubble-out text-bubble-out-foreground"
                      : "rounded-bl-md bg-muted text-foreground",
                  )}
                >
                  {item.text}
                </div>
              </div>
            ) : item.kind === "event" ? (
              <div key={i} className="self-center rounded-full bg-card-2 px-3 py-1 text-xs text-muted-foreground">
                {item.text}
              </div>
            ) : (
              <div key={i} className="self-center rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400">
                {item.text}
              </div>
            ),
          )}
          {sending && <div className="self-end text-xs text-muted-foreground">Ruth está digitando…</div>}
          <div ref={endRef} />
        </CardContent>
        <form onSubmit={handleSend} className="flex gap-2 border-t border-border p-3">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Mensagem do cliente…"
            disabled={sending}
          />
          <Button type="submit" disabled={sending || !draft.trim()}>Enviar</Button>
        </form>
      </Card>

      {/* Telemetria */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-3">
          {lastTelemetry ? (
            <>
              <span>último turno: {lastTelemetry.totalTokens ?? 0} tokens</span>
              <span>US$ {(lastTelemetry.costUsd ?? 0).toFixed(4)}</span>
              <span>{lastTelemetry.llmMs} ms</span>
              {lastTelemetry.toolsUsed.length > 0 && <span>tools: {lastTelemetry.toolsUsed.join(", ")}</span>}
            </>
          ) : (
            <span>sem turnos ainda</span>
          )}
          <span className="text-foreground">
            sessão: {totals.turns} turnos · {totals.tokens} tokens · US$ {totals.costUsd.toFixed(4)}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={handleNewConversation}>
          Nova conversa
        </Button>
      </div>
    </div>
  );
}
