'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, TrendingUp, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { LeadScoreConfig } from '@/types';

const DEFAULTS: LeadScoreConfig = {
  msg_weight: 1,
  button_weight: 3,
  link_weight: 5,
  sale_multiplier: 2,
  window_days: 30,
  hot_threshold: 50,
  warm_threshold: 20,
};

/**
 * Config admin do Lead Score: pesos por interação, janela e limiares de
 * classificação. Espelha integrations-config.tsx (fetch GET + handleSave POST).
 */
export function LeadScoreConfigPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cfg, setCfg] = useState<LeadScoreConfig>(DEFAULTS);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/lead-score/config');
        if (!res.ok) throw new Error();
        setCfg((await res.json()) as LeadScoreConfig);
      } catch {
        toast.error('Failed to load lead score config');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Atualiza um campo numérico (≥0).
  function set(field: keyof LeadScoreConfig, value: string) {
    const n = Number(value);
    setCfg((c) => ({ ...c, [field]: Number.isFinite(n) ? n : 0 }));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/lead-score/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to save');
      toast.success('Lead score salvo');
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

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <TrendingUp className="size-5 text-primary" />
          Lead Score
        </CardTitle>
        <CardDescription>
          Pontos por interação na janela escolhida. Link de venda vale o peso do
          link × multiplicador. Classificação Quente/Morno/Frio pelos limiares.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Peso por mensagem recebida">
            <NumInput value={cfg.msg_weight} onChange={(v) => set('msg_weight', v)} />
          </Field>
          <Field label="Peso por clique em botão">
            <NumInput value={cfg.button_weight} onChange={(v) => set('button_weight', v)} />
          </Field>
          <Field label="Peso por clique em link">
            <NumInput value={cfg.link_weight} onChange={(v) => set('link_weight', v)} />
          </Field>
          <Field label="Multiplicador de link de venda">
            <NumInput value={cfg.sale_multiplier} step="0.5" onChange={(v) => set('sale_multiplier', v)} />
          </Field>
          <Field label="Janela (dias)">
            <NumInput value={cfg.window_days} onChange={(v) => set('window_days', v)} />
          </Field>
          <div />
          <Field label="Limiar Quente (score ≥)">
            <NumInput value={cfg.hot_threshold} onChange={(v) => set('hot_threshold', v)} />
          </Field>
          <Field label="Limiar Morno (score ≥)">
            <NumInput value={cfg.warm_threshold} onChange={(v) => set('warm_threshold', v)} />
          </Field>
        </div>

        <div className="border-t border-border pt-4">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Salvar
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function NumInput({
  value,
  onChange,
  step,
}: {
  value: number;
  onChange: (v: string) => void;
  step?: string;
}) {
  return (
    <Input
      type="number"
      min={0}
      step={step ?? '1'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-border bg-background text-foreground"
    />
  );
}
