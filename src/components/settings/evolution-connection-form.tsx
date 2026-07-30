'use client';

// ============================================================
// Painel de conexão Evolution. Dois modos:
//  - CRIAR (connection ausente): cria a instância (POST /api/whatsapp/config
//    com provider='evolution'), exibe o QR e faz poll até 'connected'.
//  - GERENCIAR (connection presente): mostra a conexão selecionada e o
//    botão "Reconectar / novo QR" (POST /evolution/reconnect), que recria
//    a instância no servidor se ela tiver sumido.
// O poll (GET /evolution/connect) tem teto de falhas consecutivas e
// deadline — QR expira e a Evolution para de emitir após ~6 tentativas.
// ============================================================
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, QrCode, CheckCircle2, XCircle } from 'lucide-react';
import { CONNECTIONS_CHANGED_EVENT } from '@/hooks/use-active-connection';
import type { WhatsAppConfig } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

type EvoStatus = 'idle' | 'creating' | 'reconnecting' | 'pending' | 'connected' | 'error' | 'expired';

const POLL_MS = 3000;
// Teto do poll ≈ limite de QRs da instância na Evolution (6 × ~60s por QR).
const POLL_DEADLINE_MS = 3 * 60 * 1000;
// Falhas de rede/5xx consecutivas toleradas antes de interromper o poll.
const POLL_MAX_FAILS = 5;

interface EvolutionConnectionFormProps {
  /** Conexão existente selecionada → modo gerenciar; null/ausente → modo criar. */
  connection?: WhatsAppConfig | null;
  onSaved?: () => void;
}

export function EvolutionConnectionForm({ connection, onSaved }: EvolutionConnectionFormProps) {
  const { t } = useTranslation(['settingsWhatsapp', 'common']);
  const manage = Boolean(connection);
  const [instanceName, setInstanceName] = useState('');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState<EvoStatus>('idle');
  const [qr, setQr] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  // Refs do ciclo de poll: intervalo, falhas consecutivas e deadline.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const failsRef = useRef(0);
  const deadlineRef = useRef(0);

  // Limpa o poll ao desmontar (evita vazar timer).
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // Trocar a conexão selecionada zera o ciclo local (poll, QR, status).
  useEffect(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setStatus('idle');
    setQr(null);
    setConnectionId(null);
    setInstanceName('');
    setLabel('');
  }, [connection?.id]);

  // Para o poll em andamento.
  function stopPoll() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  // Cria a instância na Evolution e começa a aguardar o pareamento via QR.
  async function handleCreate() {
    if (!instanceName.trim()) {
      toast.error(t('evolution.instanceRequired'));
      return;
    }
    setStatus('creating');
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'evolution',
          instance_name: instanceName.trim(),
          label: label.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('evolution.createError'));
        setStatus('idle');
        return;
      }
      // Conexão criada → dropdown atualiza; mostra o QR e inicia o poll.
      window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
      setConnectionId(data.connection_id);
      setQr(data.qr_base64 ?? null);
      setStatus('pending');
      startPoll(data.connection_id);
    } catch {
      toast.error(t('evolution.createError'));
      setStatus('idle');
    }
  }

  // Reconecta a instância existente (recriando no servidor se preciso) e
  // reabre o ciclo de QR. Serve o modo gerenciar e o "gerar novo QR" do
  // modo criar após o deadline do poll.
  async function handleReconnect() {
    const connId = connection?.id ?? connectionId;
    if (!connId) return;
    setStatus('reconnecting');
    try {
      const res = await fetch('/api/whatsapp/evolution/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        toast.error(data?.error || t('evolution.reconnectError'));
        setStatus('error');
        return;
      }
      if (data.status === 'connected') {
        setStatus('connected');
        setQr(null);
        toast.success(t('evolution.connected'));
        window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
        onSaved?.();
        return;
      }
      if (data.recreated) toast.info(t('evolution.recreated'));
      setQr(data.qr_base64 ?? null);
      setStatus('pending');
      startPoll(connId);
    } catch {
      toast.error(t('evolution.reconnectError'));
      setStatus('error');
    }
  }

  // Poll de status/QR a cada 3s até conectar, expirar ou falhar de vez.
  function startPoll(connId: string) {
    stopPoll();
    failsRef.current = 0;
    deadlineRef.current = Date.now() + POLL_DEADLINE_MS;
    pollRef.current = setInterval(async () => {
      // QR tem validade curta; depois do teto, parar e pedir ação explícita.
      if (Date.now() > deadlineRef.current) {
        stopPoll();
        setStatus('expired');
        return;
      }
      try {
        const res = await fetch(`/api/whatsapp/evolution/connect?connection_id=${connId}`);
        const data = await res.json().catch(() => null);
        if (!res.ok || !data) throw new Error('poll failed');
        failsRef.current = 0;
        if (data.status === 'connected') {
          stopPoll();
          setStatus('connected');
          setQr(null);
          toast.success(t('evolution.connected'));
          window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
          onSaved?.();
        } else if (data.status === 'not_found') {
          // Instância sumiu do servidor — o Reconectar recria.
          stopPoll();
          setStatus('error');
          toast.error(t('evolution.notFoundHint'));
        } else if (data.qr_base64) {
          setQr(data.qr_base64);
        }
      } catch {
        // Falha isolada espera o próximo tick; persistente interrompe com aviso.
        failsRef.current += 1;
        if (failsRef.current >= POLL_MAX_FAILS) {
          stopPoll();
          setStatus('error');
          toast.error(t('evolution.pollError'));
        }
      }
    }, POLL_MS);
  }

  // Blocos compartilhados pelos dois modos (QR aguardando / conectada).
  const qrBlock = status === 'pending' && (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/30 p-4">
      <p className="text-sm text-muted-foreground">{t('evolution.scanQr')}</p>
      {qr ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={qr.startsWith('data:') ? qr : `data:image/png;base64,${qr}`} alt="QR Code" className="size-56" />
      ) : (
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      )}
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        {t('evolution.waiting')}
      </p>
    </div>
  );

  const connectedBlock = status === 'connected' && (
    <div className="flex items-center gap-2 rounded-lg border border-green-900 bg-green-950/30 p-4 text-green-300">
      <CheckCircle2 className="size-5" />
      {t('evolution.connected')}
    </div>
  );

  // ---------- MODO GERENCIAR (conexão existente selecionada) ----------
  if (manage && connection) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-foreground">{t('evolution.manageTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('evolution.manageDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Identidade da conexão — read-only: o instance_name é a
              identidade da instância no servidor. */}
          <div className="space-y-1 text-sm">
            <p className="text-foreground">{connection.label || connection.instance_name}</p>
            <p className="font-mono text-xs text-muted-foreground">{connection.instance_name}</p>
          </div>

          {/* Status persistido da row, mostrado enquanto nenhum ciclo roda. */}
          {status === 'idle' && (
            connection.status === 'connected' ? (
              <div className="flex items-center gap-2 rounded-lg border border-green-900 bg-green-950/30 p-4 text-green-300">
                <CheckCircle2 className="size-5" />
                {t('evolution.connected')}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-lg border border-red-900 bg-red-950/30 p-4 text-red-300">
                <XCircle className="size-5" />
                {t('evolution.statusDisconnected')}
              </div>
            )
          )}

          {qrBlock}
          {connectedBlock}

          {status === 'error' && (
            <p className="text-sm text-red-400">{t('evolution.notFoundHint')}</p>
          )}
          {status === 'expired' && (
            <p className="text-sm text-muted-foreground">{t('evolution.qrExpired')}</p>
          )}

          {(status === 'idle' || status === 'reconnecting' || status === 'error' || status === 'expired') && (
            <Button
              onClick={handleReconnect}
              disabled={status === 'reconnecting'}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {status === 'reconnecting' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('evolution.reconnecting')}
                </>
              ) : (
                <>
                  <QrCode className="size-4" />
                  {status === 'expired' ? t('evolution.newQr') : t('evolution.reconnect')}
                </>
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  // ---------- MODO CRIAR (nova conexão) ----------
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('evolution.title')}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('evolution.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Apelido amigável — vira o rótulo no dropdown/cards. */}
        <div className="space-y-2">
          <Label className="text-muted-foreground">{t('credentials.labelLabel')}</Label>
          <Input
            placeholder={t('credentials.labelPlaceholder')}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={status === 'pending' || status === 'connected'}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {/* Nome da instância Evolution (único por conta). */}
        <div className="space-y-2">
          <Label className="text-muted-foreground">{t('evolution.instanceLabel')}</Label>
          <Input
            placeholder={t('evolution.instancePlaceholder')}
            value={instanceName}
            onChange={(e) => setInstanceName(e.target.value)}
            disabled={status === 'pending' || status === 'connected'}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        {qrBlock}
        {connectedBlock}

        {status === 'error' && (
          <p className="text-sm text-red-400">{t('evolution.pollError')}</p>
        )}
        {status === 'expired' && (
          <p className="text-sm text-muted-foreground">{t('evolution.qrExpired')}</p>
        )}

        {(status === 'idle' || status === 'creating') && (
          <Button
            onClick={handleCreate}
            disabled={status === 'creating'}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {status === 'creating' ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('evolution.creating')}
              </>
            ) : (
              <>
                <QrCode className="size-4" />
                {t('evolution.create')}
              </>
            )}
          </Button>
        )}

        {/* QR expirou no fluxo de criação: a instância já existe — reemite
            o QR pelo reconnect em vez de criar de novo (colidiria no 409). */}
        {(status === 'expired' || status === 'error' || status === 'reconnecting') && connectionId && (
          <Button
            onClick={handleReconnect}
            disabled={status === 'reconnecting'}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {status === 'reconnecting' ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('evolution.reconnecting')}
              </>
            ) : (
              <>
                <QrCode className="size-4" />
                {t('evolution.newQr')}
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
