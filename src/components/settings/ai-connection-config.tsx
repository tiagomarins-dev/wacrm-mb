'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, PlugZap, Save } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
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

// Linha de config por conexão (ai_agent_config + nome da conexão do whatsapp_config).
interface ConnRow {
  connection_id: string;
  phone_number_id: string | null;
  is_primary: boolean;
  enabled: boolean;
  debounce_seconds: number;
  auto_unassign_minutes: number; // minutos sem interação p/ desatribuir (0 = off)
  allowed_phones: string; // textarea (um número por linha) — convertido p/ array no save
}

/**
 * Config OPERACIONAL do agente por conexão de WhatsApp: kill-switch (liga/
 * desliga), debounce e a allowlist de teste. Edita ai_agent_config direto via
 * supabase + RLS admin. O "cérebro" (persona/modelo/tools) mora no perfil.
 */
export function AiConnectionConfig() {
  const { t } = useTranslation(['settingsAiAgent', 'common']);
  const supabase = createClient();
  const { loading: authLoading, accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ConnRow[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    const [cfgRes, connRes] = await Promise.all([
      supabase.from('ai_agent_config').select('connection_id, enabled, debounce_seconds, allowed_phones, auto_unassign_minutes'),
      supabase.from('whatsapp_config').select('id, phone_number_id, is_primary'),
    ]);
    if (cfgRes.error) {
      toast.error(t('loadError'));
      setLoading(false);
      return;
    }
    const conns =
      (connRes.data as { id: string; phone_number_id: string | null; is_primary: boolean }[] | null) ?? [];
    // Indexa o config por conexão e monta UMA linha por conexão (whatsapp_config),
    // não só pelas que já têm config — pra toda conexão ser editável (save = upsert).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfgByConn = new Map<string, any>(((cfgRes.data as any[]) ?? []).map((c) => [c.connection_id, c]));
    const merged: ConnRow[] = conns.map((conn) => {
      const c = cfgByConn.get(conn.id);
      return {
        connection_id: conn.id,
        phone_number_id: conn.phone_number_id ?? null,
        is_primary: conn.is_primary ?? false,
        enabled: c?.enabled ?? false,
        debounce_seconds: c?.debounce_seconds ?? 12,
        auto_unassign_minutes: c?.auto_unassign_minutes ?? 60,
        allowed_phones: ((c?.allowed_phones as string[] | null) ?? []).join('\n'),
      };
    });
    setRows(merged);
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  // Atualiza um campo de uma linha no estado local (edição inline).
  function patch(id: string, fields: Partial<ConnRow>) {
    setRows((prev) => prev.map((r) => (r.connection_id === id ? { ...r, ...fields } : r)));
  }

  async function save(row: ConnRow) {
    // accountId pode ser null durante o load do perfil — sem ele o upsert gravaria
    // account_id null (NOT NULL). Aborta com aviso em vez de falhar silencioso.
    if (!accountId) {
      toast.error(t('saveError'));
      return;
    }
    setSavingId(row.connection_id);
    // textarea → array de dígitos; vazio = null (sem restrição = responde a todos).
    const phones = row.allowed_phones
      .split(/[\n,]/)
      .map((s) => s.replace(/\D/g, ''))
      .filter(Boolean);
    // upsert (não update): conexões sem row de config também persistem (1 row por
    // conexão, onConflict no UNIQUE(connection_id) da 037). Colunas omitidas
    // (model, max_bot_turns…) tomam DEFAULT no insert.
    const { error } = await supabase.from('ai_agent_config').upsert(
      {
        account_id: accountId,
        connection_id: row.connection_id,
        enabled: row.enabled,
        debounce_seconds: row.debounce_seconds,
        allowed_phones: phones.length ? phones : null,
        auto_unassign_minutes: row.auto_unassign_minutes,
      },
      { onConflict: 'connection_id' },
    );
    if (error) {
      toast.error((error as { code?: string })?.code === '42501' ? t('adminOnly') : t('saveError'));
    } else {
      toast.success(t('connSaved'));
    }
    setSavingId(null);
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <PlugZap className="size-5 text-primary" />
          {t('connTitle')}
        </CardTitle>
        <CardDescription>{t('connDesc')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('connEmpty')}</p>
        ) : (
          rows.map((r) => (
            <div key={r.connection_id} className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-center justify-between">
                <p className="font-mono text-sm text-foreground">
                  {r.phone_number_id ?? r.connection_id}
                  {r.is_primary && (
                    <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t('connPrimary')}
                    </span>
                  )}
                </p>
                <label className="flex items-center gap-2 text-sm text-foreground">
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(v) => patch(r.connection_id, { enabled: v })}
                  />
                  {t('connEnabled')}
                </label>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('connEnabledHint')}</p>

              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="sm:w-40">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('connDebounce')}</label>
                  <Input
                    type="number"
                    min={1}
                    max={120}
                    value={r.debounce_seconds}
                    onChange={(e) => patch(r.connection_id, { debounce_seconds: Number(e.target.value) || 12 })}
                    className="border-border bg-background text-foreground"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">{t('connDebounceHint')}</p>
                </div>
                <div className="sm:w-40">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('connAutoUnassign')}</label>
                  <Input
                    type="number"
                    min={0}
                    max={1440}
                    value={r.auto_unassign_minutes}
                    onChange={(e) => patch(r.connection_id, { auto_unassign_minutes: Number(e.target.value) || 0 })}
                    className="border-border bg-background text-foreground"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">{t('connAutoUnassignHint')}</p>
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('connAllowlist')}</label>
                  <Textarea
                    value={r.allowed_phones}
                    rows={3}
                    onChange={(e) => patch(r.connection_id, { allowed_phones: e.target.value })}
                    placeholder="21987868395"
                    className="border-border bg-background font-mono text-xs text-foreground"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">{t('connAllowlistHint')}</p>
                </div>
              </div>

              <Button
                onClick={() => save(r)}
                disabled={savingId === r.connection_id}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {savingId === r.connection_id ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t('saveChanges')}
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
