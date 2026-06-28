'use client';

// ============================================================
// Form de conexão Evolution (fase C). Isolado do form Meta p/ não
// arriscar aquele fluxo. Cria a instância (POST /api/whatsapp/config
// com provider='evolution'), exibe o QR retornado e faz POLL em
// /api/whatsapp/evolution/connect até a conexão ficar 'connected'.
// ============================================================
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, QrCode, CheckCircle2 } from 'lucide-react';
import { CONNECTIONS_CHANGED_EVENT } from '@/hooks/use-active-connection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

type EvoStatus = 'idle' | 'creating' | 'pending' | 'connected';

export function EvolutionConnectionForm({ onSaved }: { onSaved?: () => void }) {
  const { t } = useTranslation(['settingsWhatsapp', 'common']);
  const [instanceName, setInstanceName] = useState('');
  const [label, setLabel] = useState('');
  const [status, setStatus] = useState<EvoStatus>('idle');
  const [qr, setQr] = useState<string | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  // Ref do intervalo do poll p/ limpar no unmount / ao conectar.
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Limpa o poll ao desmontar (evita vazar timer).
  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

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

  // Poll de status/QR a cada 3s até conectar (sem waitForTimeout fixo).
  function startPoll(connId: string) {
    stopPoll();
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/whatsapp/evolution/connect?connection_id=${connId}`);
        const data = await res.json();
        if (data.status === 'connected') {
          stopPoll();
          setStatus('connected');
          setQr(null);
          toast.success(t('evolution.connected'));
          window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT));
          onSaved?.();
        } else if (data.qr_base64) {
          setQr(data.qr_base64);
        }
      } catch {
        /* erro transitório de rede no poll — tenta de novo no próximo tick */
      }
    }, 3000);
  }

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

        {/* QR p/ escanear no WhatsApp do celular (Aparelhos conectados). */}
        {status === 'pending' && (
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
        )}

        {status === 'connected' && (
          <div className="flex items-center gap-2 rounded-lg border border-green-900 bg-green-950/30 p-4 text-green-300">
            <CheckCircle2 className="size-5" />
            {t('evolution.connected')}
          </div>
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
      </CardContent>
    </Card>
  );
}
