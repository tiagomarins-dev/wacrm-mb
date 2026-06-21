'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Zap, CheckCircle2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { IntegrationsConfigPublic } from '@/types';

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
  // Flags de "já configurado".
  const [sets, setSets] = useState({ openrouter: false, notion: false, slack: false });

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
        setSets({
          openrouter: c.openrouter_set,
          notion: c.notion_set,
          slack: c.slack_set,
        });
      } catch {
        toast.error('Failed to load integrations');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

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
          // tokens só vão se preenchidos
          openrouter_api_key: openrouterKey || undefined,
          notion_api_key: notionKey || undefined,
          slack_bot_token: slackToken || undefined,
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
      }));
      setOpenrouterKey('');
      setNotionKey('');
      setSlackToken('');
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
