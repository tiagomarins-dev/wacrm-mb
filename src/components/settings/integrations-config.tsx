'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Zap, CheckCircle2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { IntegrationsConfigPublic, MbPaidCourse } from '@/types';

/**
 * Config admin das integrações (OpenRouter / Notion / Slack), account-level.
 * Tokens são write-only: nunca vêm do servidor; deixar o campo vazio mantém o
 * token salvo. `*_set` indica que já há token gravado.
 */
export function IntegrationsConfig() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Campos não-secretos.
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [notionDb, setNotionDb] = useState('');
  const [slackChannel, setSlackChannel] = useState('');
  // Tokens (write-only) — vazio = manter.
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [notionKey, setNotionKey] = useState('');
  const [slackToken, setSlackToken] = useState('');
  const [millaborgesKey, setMillaborgesKey] = useState('');
  // Transcrição de áudio (não-secretos). Vazio = usa o default do código.
  const [transcriptionEnabled, setTranscriptionEnabled] = useState(true);
  const [transcriptionModel, setTranscriptionModel] = useState('');
  const [transcriptionFallback, setTranscriptionFallback] = useState('');
  const [transcriptionFormat, setTranscriptionFormat] = useState('');
  // Flags de "já configurado".
  const [sets, setSets] = useState({ openrouter: false, notion: false, slack: false, millaborges: false });
  // Atribuição de venda (Fase 2): janela + cursos que contam como venda.
  const [windowDays, setWindowDays] = useState(30);
  const [courses, setCourses] = useState<MbPaidCourse[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/integrations/config');
        if (!res.ok) throw new Error();
        const c = (await res.json()) as IntegrationsConfigPublic;
        setModel(c.openrouter_model ?? '');
        setPrompt(c.openrouter_summary_prompt ?? '');
        setNotionDb(c.notion_database_id ?? '');
        setSlackChannel(c.slack_channel_id ?? '');
        setTranscriptionEnabled(c.transcription_enabled ?? true);
        setTranscriptionModel(c.transcription_model ?? '');
        setTranscriptionFallback(c.transcription_fallback_model ?? '');
        setTranscriptionFormat(c.transcription_format_model ?? '');
        setSets({
          openrouter: c.openrouter_set,
          notion: c.notion_set,
          slack: c.slack_set,
          millaborges: c.millaborges_set,
        });
        setWindowDays(c.mb_attribution_window_days ?? 30);
        // cursos vistos (admin) — não bloqueia o carregamento da config
        const cr = await fetch('/api/integrations/mb-courses', { cache: 'no-store' });
        if (cr.ok) setCourses(((await cr.json()) as { courses: MbPaidCourse[] }).courses);
      } catch {
        toast.error('Failed to load integrations');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Marca/desmarca um curso como pago (salva na hora; atualiza o estado local).
  async function toggleCourse(course: MbPaidCourse, enabled: boolean) {
    setCourses((prev) => prev.map((c) => (c.id_curso === course.id_curso ? { ...c, enabled } : c)));
    const res = await fetch('/api/integrations/mb-courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_curso: course.id_curso, nome_curso: course.nome_curso, enabled }),
    });
    if (!res.ok) {
      setCourses((prev) => prev.map((c) => (c.id_curso === course.id_curso ? { ...c, enabled: !enabled } : c)));
      toast.error('Falha ao salvar o curso');
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/integrations/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          openrouter_model: model,
          openrouter_summary_prompt: prompt,
          notion_database_id: notionDb,
          slack_channel_id: slackChannel,
          transcription_enabled: transcriptionEnabled,
          transcription_model: transcriptionModel,
          transcription_fallback_model: transcriptionFallback,
          transcription_format_model: transcriptionFormat,
          mb_attribution_window_days: windowDays,
          // tokens só vão se preenchidos
          openrouter_api_key: openrouterKey || undefined,
          notion_api_key: notionKey || undefined,
          slack_bot_token: slackToken || undefined,
          millaborges_api_key: millaborgesKey || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to save');
      toast.success('Integrations saved');
      // Limpa campos de token e marca como configurado.
      setSets((s) => ({
        openrouter: s.openrouter || !!openrouterKey,
        notion: s.notion || !!notionKey,
        slack: s.slack || !!slackToken,
        millaborges: s.millaborges || !!millaborgesKey,
      }));
      setOpenrouterKey('');
      setNotionKey('');
      setSlackToken('');
      setMillaborgesKey('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-primary" />
      </div>
    );
  }

  const tokenPlaceholder = (isSet: boolean) =>
    isSet ? '•••••••• salvo — deixe vazio p/ manter' : 'cole o token';

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Zap className="size-5 text-primary" />
          Integrations
        </CardTitle>
        <CardDescription>
          Conecte OpenRouter (resumo IA), Notion e Slack. Atendentes podem
          compartilhar conversas resumidas direto do inbox. Tokens ficam
          criptografados e nunca saem do servidor.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-8">
        {/* OpenRouter */}
        <Section title="OpenRouter (resumo IA)" connected={sets.openrouter}>
          <Field label="API key">
            <Input
              type="password"
              value={openrouterKey}
              onChange={(e) => setOpenrouterKey(e.target.value)}
              placeholder={tokenPlaceholder(sets.openrouter)}
              className="border-border bg-background text-foreground"
            />
          </Field>
          <Field label="Modelo">
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="openai/gpt-4o-mini"
              className="border-border bg-background text-foreground"
            />
          </Field>
          <Field label="Prompt do resumo (opcional)">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Deixe vazio para usar o prompt padrão."
              className="border-border bg-background text-foreground"
            />
          </Field>
        </Section>

        {/* Notion */}
        <Section title="Notion" connected={sets.notion}>
          <Field label="Internal integration token">
            <Input
              type="password"
              value={notionKey}
              onChange={(e) => setNotionKey(e.target.value)}
              placeholder={tokenPlaceholder(sets.notion)}
              className="border-border bg-background text-foreground"
            />
          </Field>
          <Field label="Database ID (destino das tarefas)">
            <Input
              value={notionDb}
              onChange={(e) => setNotionDb(e.target.value)}
              placeholder="ex: 1a2b3c4d..."
              className="border-border bg-background text-foreground"
            />
          </Field>
        </Section>

        {/* Slack */}
        <Section title="Slack" connected={sets.slack}>
          <Field label="Bot token (xoxb-…)">
            <Input
              type="password"
              value={slackToken}
              onChange={(e) => setSlackToken(e.target.value)}
              placeholder={tokenPlaceholder(sets.slack)}
              className="border-border bg-background text-foreground"
            />
          </Field>
          <Field label="Channel ID (destino)">
            <Input
              value={slackChannel}
              onChange={(e) => setSlackChannel(e.target.value)}
              placeholder="ex: C0123456789"
              className="border-border bg-background text-foreground"
            />
          </Field>
        </Section>

        {/* Plataforma do Aluno (Millaborges) — busca dados do aluno no painel da conversa */}
        <Section title="Plataforma do Aluno (Millaborges)" connected={sets.millaborges}>
          <Field label="API key">
            <Input
              type="password"
              value={millaborgesKey}
              onChange={(e) => setMillaborgesKey(e.target.value)}
              placeholder={tokenPlaceholder(sets.millaborges)}
              className="border-border bg-background text-foreground"
            />
          </Field>
        </Section>

        {/* Transcrição de áudio — modelos STT (configuráveis; vazio usa o default). */}
        <Section title="Transcrição de áudio" connected={transcriptionEnabled}>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              Transcrever áudios automaticamente
            </label>
            <Switch
              checked={transcriptionEnabled}
              onCheckedChange={setTranscriptionEnabled}
            />
          </div>
          <Field label="Modelo principal (STT)">
            <Input
              value={transcriptionModel}
              onChange={(e) => setTranscriptionModel(e.target.value)}
              placeholder="openai/whisper-large-v3-turbo"
              className="border-border bg-background text-foreground"
            />
          </Field>
          <Field label="Modelo de fallback (STT)">
            <Input
              value={transcriptionFallback}
              onChange={(e) => setTranscriptionFallback(e.target.value)}
              placeholder="openai/gpt-4o-mini-transcribe"
              className="border-border bg-background text-foreground"
            />
          </Field>
          <Field label="Modelo de formatação (correção do texto)">
            <Input
              value={transcriptionFormat}
              onChange={(e) => setTranscriptionFormat(e.target.value)}
              placeholder="openai/gpt-4o-mini"
              className="border-border bg-background text-foreground"
            />
          </Field>
        </Section>

        {/* Atribuição de venda (Fase 2): conta matrículas reais por atendente. */}
        <Section title="Atribuição de venda (matrículas)" connected={courses.some((c) => c.enabled)}>
          <Field label="Janela de atribuição (dias)">
            <Input
              type="number"
              min={1}
              max={365}
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value) || 30)}
              className="w-32 border-border bg-background text-foreground"
            />
          </Field>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Cursos que contam como venda
            </label>
            {courses.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhum curso visto ainda — aparecem aqui conforme os alunos são consultados nas conversas.
              </p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {courses.map((c) => (
                  <div key={c.id_curso} className="flex items-center justify-between px-3 py-2">
                    <span className="text-sm text-foreground">
                      {c.nome_curso || `Curso ${c.id_curso}`}
                      <span className="ml-2 font-mono text-[10px] text-muted-foreground">#{c.id_curso}</span>
                    </span>
                    <Switch checked={c.enabled} onCheckedChange={(v) => toggleCourse(c, v)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </Section>

        <div className="border-t border-border pt-4">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save integrations
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  connected,
  children,
}: {
  title: string;
  connected: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {connected && (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
            <CheckCircle2 className="size-3" /> conectado
          </span>
        )}
      </div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
