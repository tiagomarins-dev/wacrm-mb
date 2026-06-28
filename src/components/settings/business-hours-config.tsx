'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Clock, Save } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card';
import type { BusinessScheduleEntry } from '@/types';

// Schedule default: seg–sex 09:00–18:00; fim de semana fechado.
function defaultSchedule(): BusinessScheduleEntry[] {
  return [0, 1, 2, 3, 4, 5, 6].map((dow) => ({
    dow,
    enabled: dow >= 1 && dow <= 5,
    open: '09:00',
    close: '18:00',
  }));
}

// Garante 7 entradas (dow 0..6) a partir do que veio do banco (pode vir parcial).
function normalize(schedule: BusinessScheduleEntry[] | null | undefined): BusinessScheduleEntry[] {
  const base = defaultSchedule();
  if (!schedule || schedule.length === 0) return base;
  return base.map((d) => schedule.find((s) => s.dow === d.dow) ?? d);
}

// Uma linha por conexão (whatsapp_config) com seu horário (business_hours).
interface ConnRow {
  connection_id: string;
  phone_number_id: string | null;
  is_primary: boolean;
  timezone: string;
  schedule: BusinessScheduleEntry[];
}

/**
 * Config de HORÁRIO DE ATENDIMENTO por conexão (tabela business_hours).
 * Edita direto via supabase + RLS admin (espelha ai-connection-config.tsx).
 * O clipping do tempo de resposta usa estas janelas (mig 049/050).
 */
export function BusinessHoursConfig() {
  const { t } = useTranslation(['settingsBusinessHours', 'common']);
  const supabase = createClient();
  const { loading: authLoading, accountId } = useAuth();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ConnRow[]>([]);
  const [savingId, setSavingId] = useState<string | null>(null);

  // Monta 1 linha por conexão (toda conexão editável; save = upsert).
  const fetchRows = useCallback(async () => {
    setLoading(true);
    const [bhRes, connRes] = await Promise.all([
      supabase.from('business_hours').select('connection_id, timezone, schedule'),
      supabase.from('whatsapp_config').select('id, phone_number_id, is_primary'),
    ]);
    if (connRes.error) {
      toast.error(t('loadError'));
      setLoading(false);
      return;
    }
    const conns =
      (connRes.data as { id: string; phone_number_id: string | null; is_primary: boolean }[] | null) ?? [];
    const bhByConn = new Map<string, { timezone: string; schedule: BusinessScheduleEntry[] }>(
      ((bhRes.data as { connection_id: string; timezone: string; schedule: BusinessScheduleEntry[] }[] | null) ?? [])
        .map((b) => [b.connection_id, b]),
    );
    setRows(conns.map((conn) => {
      const bh = bhByConn.get(conn.id);
      return {
        connection_id: conn.id,
        phone_number_id: conn.phone_number_id ?? null,
        is_primary: conn.is_primary ?? false,
        timezone: bh?.timezone ?? 'America/Sao_Paulo',
        schedule: normalize(bh?.schedule),
      };
    }));
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    fetchRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  // Edição inline de uma conexão / de um dia do schedule.
  function patch(id: string, fields: Partial<ConnRow>) {
    setRows((prev) => prev.map((r) => (r.connection_id === id ? { ...r, ...fields } : r)));
  }
  function patchDay(id: string, dow: number, fields: Partial<BusinessScheduleEntry>) {
    setRows((prev) => prev.map((r) =>
      r.connection_id === id
        ? { ...r, schedule: r.schedule.map((d) => (d.dow === dow ? { ...d, ...fields } : d)) }
        : r,
    ));
  }

  async function save(row: ConnRow) {
    // accountId pode ser null durante o load do perfil — sem ele o upsert gravaria
    // account_id null (NOT NULL). Aborta com aviso em vez de falhar silencioso.
    if (!accountId) {
      toast.error(t('saveError'));
      return;
    }
    setSavingId(row.connection_id);
    // upsert por (account_id, connection_id) — unique COMPOSTO da 049.
    const { error } = await supabase.from('business_hours').upsert(
      {
        account_id: accountId,
        connection_id: row.connection_id,
        timezone: row.timezone,
        schedule: row.schedule,
      },
      { onConflict: 'account_id,connection_id' },
    );
    if (error) {
      toast.error((error as { code?: string })?.code === '42501' ? t('adminOnly') : t('saveError'));
    } else {
      toast.success(t('saved'));
    }
    setSavingId(null);
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Clock className="size-5 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('desc')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          rows.map((r) => (
            <div key={r.connection_id} className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-mono text-sm text-foreground">
                  {r.phone_number_id ?? r.connection_id}
                  {r.is_primary && (
                    <span className="ml-2 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                      {t('primary')}
                    </span>
                  )}
                </p>
                <div className="w-52">
                  <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('timezone')}</label>
                  <Input
                    value={r.timezone}
                    onChange={(e) => patch(r.connection_id, { timezone: e.target.value })}
                    placeholder="America/Sao_Paulo"
                    className="border-border bg-background font-mono text-xs text-foreground"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                {r.schedule.map((d) => (
                  <div key={d.dow} className="flex items-center gap-3">
                    <label className="flex w-32 items-center gap-2 text-sm text-foreground">
                      <Switch
                        checked={d.enabled}
                        onCheckedChange={(v) => patchDay(r.connection_id, d.dow, { enabled: v })}
                      />
                      {t(`dow${d.dow}`)}
                    </label>
                    <Input
                      type="time"
                      value={d.open}
                      disabled={!d.enabled}
                      onChange={(e) => patchDay(r.connection_id, d.dow, { open: e.target.value })}
                      className="w-32 border-border bg-background text-foreground"
                    />
                    <span className="text-xs text-muted-foreground">—</span>
                    <Input
                      type="time"
                      value={d.close}
                      disabled={!d.enabled}
                      onChange={(e) => patchDay(r.connection_id, d.dow, { close: e.target.value })}
                      className="w-32 border-border bg-background text-foreground"
                    />
                  </div>
                ))}
              </div>

              <Button
                onClick={() => save(r)}
                disabled={savingId === r.connection_id}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {savingId === r.connection_id ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                {t('save')}
              </Button>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
