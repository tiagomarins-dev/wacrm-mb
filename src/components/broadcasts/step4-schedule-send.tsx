'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isFuture } from 'date-fns';
import { createClient } from '@/lib/supabase/client';
import { useFormat } from '@/lib/i18n/format';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Users, Save, CalendarClock, Webhook } from 'lucide-react';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string; extras?: Record<string, string> }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  /** Cria um blueprint webhook (mig 075) em vez de enviar/agendar. */
  onCreateWebhook?: () => void;
  /** Alguma variável do step3 é do tipo 'payload' — trava now/schedule. */
  hasPayloadVars?: boolean;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
  /** ISO do agendamento (null = enviar agora). */
  scheduledAt: string | null;
  onScheduleChange: (iso: string | null) => void;
  /** Perfil de IA vinculado à campanha (null = atendimento humano). */
  aiProfileId: string | null;
  onAiProfileChange: (id: string | null) => void;
  /** Tag aplicada a quem receber o disparo (null = não marcar). */
  tagName: string | null;
  onTagNameChange: (name: string | null) => void;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onCreateWebhook,
  hasPayloadVars,
  onBack,
  isProcessing,
  progress,
  scheduledAt,
  onScheduleChange,
  aiProfileId,
  onAiProfileChange,
  tagName,
  onTagNameChange,
}: Step4Props) {
  const { t } = useTranslation(['broadcastWizard', 'common']);
  // Formatação de data/hora pelo idioma ativo (substitui o `format` do date-fns).
  const { formatDateTime } = useFormat();
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);
  // Modo de envio + valor do input datetime-local (hora local).
  const [timing, setTiming] = useState<'now' | 'schedule' | 'webhook'>(
    hasPayloadVars ? 'webhook' : 'now',
  );
  const [localDt, setLocalDt] = useState('');
  // Perfis de IA atribuíveis — view pública (RLS escopa por conta; a base é admin-only).
  const [aiProfiles, setAiProfiles] = useState<{ id: string; nome: string }[]>([]);

  useEffect(() => {
    const supabase = createClient();
    void supabase
      .from('ai_profiles_public')
      .select('id, nome, enabled')
      .eq('enabled', true)
      .then(({ data }) => setAiProfiles((data as { id: string; nome: string }[] | null) ?? []));
  }, []);

  // Agendamento válido = modo schedule + data futura preenchida.
  const scheduleValid =
    timing === 'schedule' && !!localDt && isFuture(new Date(localDt));
  const scheduling = timing === 'schedule';
  const webhookMode = timing === 'webhook';
  // Variável de payload só resolve no disparo do webhook — trava now/schedule.
  const payloadBlocked = !webhookMode && !!hasPayloadVars;

  // Converte o input local em ISO e propaga (null se inválido).
  function handleDtChange(value: string) {
    setLocalDt(value);
    const valid = value && isFuture(new Date(value));
    onScheduleChange(valid ? new Date(value).toISOString() : null);
  }

  function selectTiming(mode: 'now' | 'schedule' | 'webhook') {
    setTiming(mode);
    if (mode === 'now' || mode === 'webhook') onScheduleChange(null);
    else handleDtChange(localDt); // revalida o valor atual
  }

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('step4.audienceAll')
      : audience.type === 'tags'
        ? t('step4.audienceTags', { count: audience.tagIds?.length ?? 0 })
        : audience.type === 'csv'
          ? t('step4.audienceCsv')
          : t('step4.audienceCustom');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('step4.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('step4.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('step4.nameLabel')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('step4.namePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('step4.summaryTitle')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('step4.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('step4.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('step4.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('step4.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
        </div>
      </div>

      {/* Agente de IA da campanha: quem responde quando o lead retorna o template */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-1 text-sm font-medium text-foreground">{t('step4.aiProfileLabel')}</p>
        <select
          value={aiProfileId ?? ''}
          onChange={(e) => onAiProfileChange(e.target.value || null)}
          disabled={isProcessing}
          className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
        >
          <option value="">{t('step4.aiProfileNone')}</option>
          {aiProfiles.map((p) => (
            <option key={p.id} value={p.id}>{p.nome}</option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">{t('step4.aiProfileHint')}</p>
      </div>

      {/* Tag do disparo: marca quem RECEBEU, para filtrar depois em Contatos */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-1 text-sm font-medium text-foreground">{t('step4.tagLabel')}</p>
        <Input
          value={tagName ?? ''}
          onChange={(e) => onTagNameChange(e.target.value || null)}
          disabled={isProcessing}
          placeholder={t('step4.tagPlaceholder')}
          className="h-9 border-border bg-muted text-sm text-foreground"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('step4.tagHint')}</p>
      </div>

      {/* Send timing */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('step4.sendTiming')}</p>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={timing === 'now' ? 'default' : 'outline'}
            onClick={() => selectTiming('now')}
            disabled={isProcessing}
            className={
              timing === 'now'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'border-border text-muted-foreground'
            }
          >
            <Send className="h-4 w-4" />
            {t('step4.sendNow')}
          </Button>
          <Button
            type="button"
            variant={timing === 'schedule' ? 'default' : 'outline'}
            onClick={() => selectTiming('schedule')}
            disabled={isProcessing}
            className={
              timing === 'schedule'
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'border-border text-muted-foreground'
            }
          >
            <CalendarClock className="h-4 w-4" />
            {t('step4.schedule')}
          </Button>
          {onCreateWebhook && (
            <Button
              type="button"
              variant={webhookMode ? 'default' : 'outline'}
              onClick={() => selectTiming('webhook')}
              disabled={isProcessing}
              className={
                webhookMode
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'border-border text-muted-foreground'
              }
            >
              <Webhook className="h-4 w-4" />
              {t('step4.webhookMode')}
            </Button>
          )}
        </div>
        {timing === 'schedule' && (
          <div className="space-y-1.5">
            <Input
              type="datetime-local"
              value={localDt}
              onChange={(e) => handleDtChange(e.target.value)}
              disabled={isProcessing}
              className="border-border bg-muted text-foreground"
            />
            {localDt && !scheduleValid && (
              <p className="text-xs text-red-400">{t('step4.pickFutureDate')}</p>
            )}
          </div>
        )}
        {webhookMode && (
          <p className="text-xs text-muted-foreground">
            {t('step4.webhookModeHint')}
          </p>
        )}
        {payloadBlocked && (
          <p className="text-xs text-amber-400">
            {t('step4.payloadNeedsWebhook')}
          </p>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">
                {scheduling ? t('step4.scheduling') : t('step4.sending')}
              </p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('common.back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('step4.saveAsDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={
                  !name.trim() ||
                  isProcessing ||
                  (scheduling && !scheduleValid) ||
                  payloadBlocked
                }
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {webhookMode ? (
              <Webhook className="h-4 w-4" />
            ) : scheduling ? (
              <CalendarClock className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {webhookMode
              ? t('step4.createWebhook')
              : scheduling
                ? t('step4.scheduleBroadcast')
                : t('step4.sendBroadcast')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {webhookMode
                  ? t('step4.confirmWebhookTitle')
                  : scheduling
                    ? t('step4.confirmScheduleTitle')
                    : t('step4.confirmBroadcastTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {webhookMode ? (
                  <>{t('step4.confirmWebhookDesc', { template: template.name })}</>
                ) : scheduling ? (
                  <>
                    {t('step4.confirmScheduleDescPrefix')}{' '}
                    <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                    {t('step4.confirmScheduleDescMiddle')}{' '}
                    <span className="font-medium text-popover-foreground">{template.name}</span>{' '}
                    {t('step4.confirmScheduleDescTemplate')}{' '}
                    <span className="font-medium text-popover-foreground">
                      {localDt ? formatDateTime(new Date(localDt)) : ''}
                    </span>
                    .
                  </>
                ) : (
                  <>
                    {t('step4.confirmSendDescPrefix')}{' '}
                    <span className="font-medium text-popover-foreground">{estimatedReach.toLocaleString()}</span>{' '}
                    {t('step4.confirmSendDescMiddle')}{' '}
                    <span className="font-medium text-popover-foreground">{template.name}</span>
                    {t('step4.confirmSendDescSuffix')}
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('common:cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  // Modo webhook cria o blueprint em vez de enviar/agendar.
                  if (webhookMode) onCreateWebhook?.();
                  else onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {webhookMode ? (
                  <Webhook className="h-4 w-4" />
                ) : scheduling ? (
                  <CalendarClock className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {webhookMode
                  ? t('step4.confirmAndCreateWebhook')
                  : scheduling
                    ? t('step4.confirmAndSchedule')
                    : t('step4.confirmAndSend')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
