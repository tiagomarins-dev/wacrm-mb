'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { CONNECTIONS_CHANGED_EVENT } from '@/hooks/use-active-connection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import { useFormat } from '@/lib/i18n/format';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;

export function WhatsAppConfig() {
  // i18n: strings da tela vêm de `settingsWhatsapp`; rótulos genéricos de `common`.
  const { t } = useTranslation(['settingsWhatsapp', 'common']);
  // Formatação de data/hora pelo idioma ativo (substitui o toLocaleString hardcoded).
  const { formatDateTime } = useFormat();
  const supabase = createClient();
  // After multi-user, whatsapp_config is one-row-per-account, not
  // one-row-per-user. We pull `accountId` straight off the auth
  // context and key every read off it — so a teammate who just
  // joined an account sees the inviter's saved config without
  // having to re-enter anything.
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  // Multi-número (033): a conta pode ter várias conexões. `connections` é a
  // lista; `selectedId` é a que está no formulário (null = adicionando nova).
  const [connections, setConnections] = useState<WhatsAppConfigType[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  // Apelido da conexão (055) — rótulo exibido no dropdown/cards.
  const [label, setLabel] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  // Popula o formulário a partir de uma conexão (ou limpa, p/ "adicionar nova").
  const populateForm = useCallback((row: WhatsAppConfigType | null) => {
    if (row) {
      setConfig(row);
      setPhoneNumberId(row.phone_number_id || '');
      setWabaId(row.waba_id || '');
      setAccessToken(MASKED_TOKEN);
      setLabel(row.label || '');
    } else {
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setLabel('');
    }
    setVerifyToken('');
    setPin('');
    setTokenEdited(false);
    setRegistrationProbe(null);
  }, []);

  // Carrega TODAS as conexões da conta (multi-número, 033). Sem `.maybeSingle()`
  // (que quebraria com 2+). Seleciona uma para o formulário: a preferida (recém
  // salva) → a já selecionada → a primária → a 1ª.
  const loadConnections = useCallback(
    async (acctId: string, preferId?: string | null) => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from('whatsapp_config')
          .select('*')
          .eq('account_id', acctId)
          .order('is_primary', { ascending: false })
          .order('created_at', { ascending: true });
        if (error) console.error('Failed to load connections:', error);

        const list = (data ?? []) as WhatsAppConfigType[];
        setConnections(list);

        const pick =
          (preferId && list.find((c) => c.id === preferId)) ||
          (selectedId && list.find((c) => c.id === selectedId)) ||
          list.find((c) => c.is_primary) ||
          list[0] ||
          null;
        setSelectedId(pick?.id ?? null);
        populateForm(pick ?? null);

        // Health check (decripta token + pinga a Meta) da conexão primária.
        if (pick) {
          try {
            const res = await fetch('/api/whatsapp/config', { method: 'GET' });
            const payload = await res.json();
            if (payload.connected) {
              setConnectionStatus('connected');
              setResetReason(null);
              setStatusMessage('');
            } else {
              setConnectionStatus('disconnected');
              setResetReason(
                payload.needs_reset
                  ? 'token_corrupted'
                  : payload.reason === 'meta_api_error'
                    ? 'meta_api_error'
                    : null,
              );
              setStatusMessage(payload.message || '');
            }
          } catch (err) {
            console.error('Health check failed:', err);
            setConnectionStatus('disconnected');
          }
        } else {
          setConnectionStatus('disconnected');
          setResetReason(null);
          setStatusMessage('');
        }
      } catch (err) {
        console.error('loadConnections error:', err);
        toast.error(t('loadConfigError'));
      } finally {
        setLoading(false);
      }
    },
    [supabase, selectedId, populateForm, t],
  );

  // Seleciona uma conexão existente para edição, ou null para "adicionar nova".
  function selectConnection(id: string | null) {
    setSelectedId(id);
    populateForm(id ? connections.find((c) => c.id === id) ?? null : null);
    setConnectionStatus('unknown');
    setResetReason(null);
    setStatusMessage('');
  }

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoading(false);
      return;
    }
    loadConnections(accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, profileLoading, user, accountId]);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error(t('toasts.phoneNumberIdRequired'));
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error(t('toasts.accessTokenRequiredInitial'));
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        // Editando uma conexão existente → manda o id (UPDATE). Adicionando
        // (selectedId null) → omite → o backend cria uma conexão NOVA.
        connection_id: selectedId ?? undefined,
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        // Apelido (055) — opcional; null vira fallback no phone_number_id.
        label: label.trim() || null,
        verify_token: verifyToken.trim() || null,
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error(t('toasts.reenterTokenToSave'));
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('toasts.saveConfigError'));
        setSaving(false);
        return;
      }

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        toast.error(
          t('toasts.savedButNotRegistered', { error: data.registration_error }),
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(t('toasts.savedRegistrationSkipped'), { duration: 10000 });
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? t('toasts.connectedLive', { name: data.phone_info.verified_name })
            : t('toasts.connectedGeneric'),
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      // Recarrega a lista e avisa o provider (dropdown) — o seletor de conexão
      // aparece/atualiza automaticamente, sem recarregar a página.
      if (accountId) await loadConnections(accountId);
      window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
    } catch (err) {
      console.error('Save error:', err);
      toast.error(t('toasts.saveConfigError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        toast.success(
          payload.phone_info?.verified_name
            ? t('toasts.connectedToName', { name: payload.phone_info.verified_name })
            : t('toasts.apiConnectionSuccess')
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(payload.needs_reset ? 'token_corrupted' : payload.reason === 'meta_api_error' ? 'meta_api_error' : null);
        setStatusMessage(payload.message || '');
        toast.error(payload.message || t('toasts.apiConnectionFailed'));
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error(t('toasts.connectionTestFailed'));
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch('/api/whatsapp/config/verify-registration', {
        method: 'GET',
      });
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success(t('toasts.registrationLive'));
      } else {
        toast.error(t('toasts.registrationNotComplete'), { duration: 8000 });
      }
      if (accountId) await loadConnections(accountId);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error(t('toasts.verificationEndpointError'));
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!confirm(t('resetConfirm'))) {
      return;
    }

    try {
      setResetting(true);
      // Multi-número (033): desconecta a conexão SELECIONADA (DELETE é soft —
      // status='disconnected'; FK RESTRICT impede hard-delete com dados).
      const url = selectedId
        ? `/api/whatsapp/config?id=${encodeURIComponent(selectedId)}`
        : '/api/whatsapp/config';
      const res = await fetch(url, { method: 'DELETE' });
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('toasts.resetConfigError'));
        return;
      }

      toast.success(t('toasts.connectionReset'));
      if (accountId) await loadConnections(accountId);
      window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
    } catch (err) {
      console.error('Reset error:', err);
      toast.error(t('toasts.resetConfigError'));
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success(t('toasts.webhookUrlCopied'));
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title={t('panelTitle')}
          description={t('panelDescription')}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title={t('panelTitle')}
        description={t('panelDescription')}
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      {/* Main config form */}
      <div className="space-y-6">
        {/* Corrupted-token reset banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  {t('resetBanner.title')}
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <Button
                  onClick={handleReset}
                  disabled={resetting}
                  size="sm"
                  className="mt-3 bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {resetting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      {t('resetBanner.resetting')}
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      {t('resetBanner.resetConfiguration')}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection Status */}
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {connectionStatus === 'connected' ? t('status.credentialsValid') : t('status.notConnected')}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {connectionStatus === 'connected'
              ? t('status.credentialsValidDesc')
              : statusMessage || t('status.configurePrompt')}
          </AlertDescription>
        </Alert>

        {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
        {config && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle
                  className={
                    'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')
                  }
                >
                  {isRegistered
                    ? t('registration.registeredTitle')
                    : t('registration.notRegisteredTitle')}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Zap className="size-3.5" />
                )}
                {t('registration.verifyWithMeta')}
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <>
                  {t('registration.subscribedSince', {
                    date: config.registered_at
                      ? formatDateTime(config.registered_at)
                      : t('registration.subscribedSinceUnknown'),
                  })}
                  {t('registration.clickVerifyPrefix')}
                  <strong>{t('registration.verifyWithMeta')}</strong>
                  {t('registration.clickVerifySuffix')}
                </>
              ) : lastRegistrationError ? (
                <>
                  {t('registration.lastAttemptPrefix')}
                  <span className="text-red-300">
                    &quot;{lastRegistrationError}&quot;
                  </span>
                  {t('registration.lastAttemptSuffix')}
                </>
              ) : (
                <>{t('registration.savedBeforeTracking')}</>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  {t('registration.diagnosticLastRun')} {' '}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? t('registration.diagnosticLive') : t('registration.diagnosticNotLive')}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {/* Conexões (multi-número, 033) — lista + adicionar. Trocar de
            número no app é pelo seletor do header; aqui é onde se conecta
            e edita cada número. */}
        {connections.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">{t('connections.title')}</CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('connections.description')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {connections.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => selectConnection(c.id)}
                    className={
                      'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ' +
                      (selectedId === c.id
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted')
                    }
                  >
                    <span className="font-mono">{c.phone_number_id}</span>
                    {c.is_primary && (
                      <span className="rounded bg-primary/20 px-1 text-[10px] uppercase text-primary">
                        {t('connections.primary')}
                      </span>
                    )}
                    {c.status === 'disconnected' && (
                      <XCircle className="size-3.5 text-red-500" />
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => selectConnection(null)}
                  className={
                    'flex items-center gap-1.5 rounded-md border border-dashed px-3 py-1.5 text-sm transition-colors ' +
                    (selectedId === null
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground/40')
                  }
                >
                  {t('connections.addNumber')}
                </button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* API Credentials */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">
              {selectedId ? t('credentials.editTitle') : t('credentials.title')}
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('credentials.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Apelido amigável — vira o rótulo no dropdown/cards (helper connectionLabel) */}
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('credentials.labelLabel')}</Label>
              <Input
                placeholder={t('credentials.labelPlaceholder')}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('credentials.phoneNumberIdLabel')}</Label>
              <Input
                placeholder={t('credentials.phoneNumberIdPlaceholder')}
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('credentials.wabaIdLabel')}</Label>
              <Input
                placeholder={t('credentials.wabaIdPlaceholder')}
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('credentials.accessTokenLabel')}</Label>
              <div className="relative">
                <Input
                  type={showToken ? 'text' : 'password'}
                  placeholder={t('credentials.accessTokenPlaceholder')}
                  value={accessToken}
                  onChange={(e) => {
                    setAccessToken(e.target.value);
                    setTokenEdited(true);
                  }}
                  onFocus={() => {
                    if (accessToken === MASKED_TOKEN) {
                      setAccessToken('');
                      setTokenEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
              {config && !tokenEdited && (
                <p className="text-xs text-muted-foreground">
                  {t('credentials.tokenHiddenHint')}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('credentials.verifyTokenLabel')}</Label>
              <Input
                placeholder={t('credentials.verifyTokenPlaceholder')}
                value={verifyToken}
                onChange={(e) => setVerifyToken(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
              <p className="text-xs text-muted-foreground">
                {t('credentials.verifyTokenHint')}
              </p>
            </div>

            <div className="space-y-2">
              <Label className="text-muted-foreground">
                {t('credentials.pinLabel')}
                <span className="ml-1 text-muted-foreground">{t('credentials.pinOptional')}</span>
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder={t('credentials.pinPlaceholder')}
                value={pin}
                onChange={(e) =>
                  setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                }
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
              />
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('credentials.pinHintPart1')}
                <strong className="text-muted-foreground">{t('credentials.pinHintInbound')}</strong>
                {t('credentials.pinHintPart2')}
                <strong className="text-muted-foreground">{t('credentials.pinHintProduction')}</strong>
                {t('credentials.pinHintPart3')}
                <strong className="text-muted-foreground">
                  {t('credentials.pinHintMetaPath')}
                </strong>
                {t('credentials.pinHintPart4')}
                <strong className="text-muted-foreground">{t('credentials.pinHintMetaTestNumbers')}</strong>
                {t('credentials.pinHintPart5')}
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Webhook URL */}
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">{t('webhook.title')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('webhook.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhook.callbackUrlLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Action Buttons */}
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('actions.saving')}
              </>
            ) : (
              t('actions.saveConfiguration')
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={testing || !config}
            className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
          >
            {testing ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('actions.testing')}
              </>
            ) : (
              <>
                <Zap className="size-4" />
                {t('actions.testApiConnection')}
              </>
            )}
          </Button>
          {config && (
            <Button
              variant="outline"
              onClick={handleReset}
              disabled={resetting}
              className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
            >
              {resetting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('resetBanner.resetting')}
                </>
              ) : (
                <>
                  <RotateCcw className="size-4" />
                  {t('resetBanner.resetConfiguration')}
                </>
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Setup Instructions Sidebar */}
      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-foreground text-base">{t('setup.title')}</CardTitle>
            <CardDescription className="text-muted-foreground">
              {t('setup.description')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                    {t('setup.step1Title')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('setup.step1Item1Prefix')}<span className="text-primary">{t('setup.step1Item1Link')}</span></li>
                    <li>{t('setup.step1Item2')}</li>
                    <li>{t('setup.step1Item3')}</li>
                    <li>{t('setup.step1Item4')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                    {t('setup.step2Title')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('setup.step2Item1')}</li>
                    <li>{t('setup.step2Item2')}</li>
                    <li>{t('setup.step2Item3')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                    {t('setup.step3Title')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('setup.step3Item1')}</li>
                    <li>{t('setup.step3Item2Prefix')}<strong className="text-foreground">{t('setup.step3Item2Strong')}</strong></li>
                    <li>{t('setup.step3Item3Prefix')}<strong className="text-foreground">{t('setup.step3Item3Strong')}</strong></li>
                    <li>{t('setup.step3Item4Prefix')}<strong className="text-foreground">{t('setup.step3Item4Strong')}</strong>{t('setup.step3Item4Suffix')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem className="border-border">
                <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                  <span className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                    {t('setup.step4Title')}
                  </span>
                </AccordionTrigger>
                <AccordionContent className="text-muted-foreground">
                  <ol className="list-decimal list-inside space-y-1 text-sm">
                    <li>{t('setup.step4Item1')}</li>
                    <li>{t('setup.step4Item2')}</li>
                    <li>{t('setup.step4Item3Prefix')}<strong className="text-foreground">{t('setup.step4Item3Strong')}</strong>{t('setup.step4Item3Suffix')}</li>
                    <li>{t('setup.step4Item4Prefix')}<strong className="text-foreground">{t('setup.step4Item4Strong')}</strong>{t('setup.step4Item4Suffix')}</li>
                    <li>{t('setup.step4Item5')}</li>
                  </ol>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            <div className="mt-4 pt-4 border-t border-border">
              <a
                href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('setup.docsLink')}
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
    </section>
  );
}
