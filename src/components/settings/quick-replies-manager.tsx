'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, MessageSquare, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { QUICK_REPLY_VARS } from '@/lib/inbox/quick-replies';
import type { QuickReply } from '@/types';

type Scope = 'account' | 'personal';
const SHORTCUT_MAX = 32;
const MESSAGE_MAX = 1000;

/**
 * Gerencia respostas rápidas (quick replies). Dois escopos:
 * compartilhadas (account, só admin) e pessoais (do próprio agente).
 * No inbox, digitar `/` abre o menu com essas respostas.
 */
export function QuickRepliesManager() {
  const { t } = useTranslation(['settingsQuickReplies', 'common']);
  const supabase = createClient();
  const { user, accountId, loading: authLoading } = useAuth();
  const canEditShared = useCan('edit-settings');

  const [loading, setLoading] = useState(true);
  const [replies, setReplies] = useState<QuickReply[]>([]);

  // Form (cria ou edita). editingId != null = modo edição.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [message, setMessage] = useState('');
  // Não-admin só cria pessoal; admin escolhe. scope é imutável na edição.
  const [scope, setScope] = useState<Scope>('personal');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<QuickReply | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchReplies = useCallback(async () => {
    setLoading(true);
    // RLS devolve as compartilhadas da conta + as próprias pessoais.
    const { data, error } = await supabase
      .from('quick_replies')
      .select('*')
      .order('shortcut', { ascending: true });
    if (error) {
      toast.error(t('loadError'));
      setLoading(false);
      return;
    }
    setReplies(data ?? []);
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    fetchReplies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  function resetForm() {
    setEditingId(null);
    setShortcut('');
    setMessage('');
    setScope(canEditShared ? 'account' : 'personal');
  }

  function startEdit(r: QuickReply) {
    setEditingId(r.id);
    setShortcut(r.shortcut);
    setMessage(r.message_text);
    setScope(r.scope); // imutável na edição
  }

  async function handleSubmit() {
    const sc = shortcut.trim();
    const msg = message.trim();
    if (!sc || !msg) {
      toast.error(t('requiredError'));
      return;
    }
    if (!user || !accountId) {
      toast.error(t('notAuthenticated'));
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        // scope não muda na edição (RLS bloquearia promover personal→account).
        const { error } = await supabase
          .from('quick_replies')
          .update({ shortcut: sc, message_text: msg })
          .eq('id', editingId);
        if (error) throw error;
        toast.success(t('updatedToast'));
      } else {
        const { error } = await supabase.from('quick_replies').insert({
          account_id: accountId,
          user_id: user.id,
          scope,
          shortcut: sc,
          message_text: msg,
        });
        if (error) throw error;
        toast.success(t('createdToast'));
      }
      resetForm();
      await fetchReplies();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === '42501') {
        toast.error(t('adminOnlyManage'));
      } else if (code === '23505') {
        toast.error(t('duplicateShortcut'));
      } else {
        toast.error(t('saveError'));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase
      .from('quick_replies')
      .delete()
      .eq('id', deleteTarget.id);
    if (error) {
      toast.error(
        (error as { code?: string })?.code === '42501'
          ? t('adminOnlyDelete')
          : t('deleteError'),
      );
    } else {
      toast.success(t('deletedToast'));
      if (editingId === deleteTarget.id) resetForm();
      await fetchReplies();
    }
    setDeleting(false);
    setDeleteTarget(null);
  }

  // Edição/exclusão de uma compartilhada exige admin.
  const canModify = (r: QuickReply) => r.scope === 'personal' || canEditShared;

  const shared = replies.filter((r) => r.scope === 'account');
  const personal = replies.filter((r) => r.scope === 'personal');

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <MessageSquare className="size-5 text-primary" />
          {t('title')}
        </CardTitle>
        <CardDescription>
          {t('descriptionPrefix')}{' '}
          <code className="rounded bg-muted px-1">/</code> {t('descriptionMiddle')}{' '}
          {QUICK_REPLY_VARS.map((v) => `{{${v}}}`).join(', ')}{' '}
          {t('descriptionSuffix')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Form: create / edit */}
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="sm:w-48">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('shortcutLabel')}
              </label>
              <Input
                value={shortcut}
                maxLength={SHORTCUT_MAX}
                onChange={(e) => setShortcut(e.target.value)}
                placeholder={t('shortcutPlaceholder')}
                className="border-border bg-background text-foreground"
              />
            </div>
            {/* Escopo: admin escolhe; na edição fica travado. */}
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('scopeLabel')}
              </label>
              <div className="flex gap-2">
                {(canEditShared
                  ? (['account', 'personal'] as Scope[])
                  : (['personal'] as Scope[])
                ).map((s) => (
                  <Button
                    key={s}
                    type="button"
                    variant={scope === s ? 'default' : 'outline'}
                    disabled={!!editingId}
                    onClick={() => setScope(s)}
                    className={cn(
                      'h-9',
                      scope === s
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'border-border text-muted-foreground',
                    )}
                  >
                    {s === 'account' ? t('scopeShared') : t('scopePersonal')}
                  </Button>
                ))}
              </div>
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('messageLabel')}
            </label>
            <Textarea
              value={message}
              maxLength={MESSAGE_MAX}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t('messagePlaceholder')}
              rows={3}
              className="border-border bg-background text-foreground"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={handleSubmit}
              disabled={saving || !shortcut.trim() || !message.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : editingId ? (
                <Pencil className="size-4" />
              ) : (
                <Plus className="size-4" />
              )}
              {editingId ? t('saveChanges') : t('addReply')}
            </Button>
            {editingId && (
              <Button
                variant="outline"
                onClick={resetForm}
                className="border-border text-muted-foreground"
              >
                <X className="size-4" />
                {t('cancel', { ns: 'common' })}
              </Button>
            )}
          </div>
        </div>

        {/* Lists */}
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-6">
            <QuickReplyList
              title={t('sharedListTitle')}
              empty={t('sharedListEmpty')}
              items={shared}
              canModify={canModify}
              onEdit={startEdit}
              onDelete={setDeleteTarget}
            />
            <QuickReplyList
              title={t('personalListTitle')}
              empty={t('personalListEmpty')}
              items={personal}
              canModify={canModify}
              onEdit={startEdit}
              onDelete={setDeleteTarget}
            />
          </div>
        )}
      </CardContent>

      {/* Delete confirm */}
      <Dialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {t('deleteTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteConfirmPrefix')}{' '}
              <span className="font-medium text-popover-foreground">
                /{deleteTarget?.shortcut}
              </span>
              {t('deleteConfirmSuffix')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              className="border-border text-muted-foreground"
            >
              {t('cancel', { ns: 'common' })}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('delete', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function QuickReplyList({
  title,
  empty,
  items,
  canModify,
  onEdit,
  onDelete,
}: {
  title: string;
  empty: string;
  items: QuickReply[];
  canModify: (r: QuickReply) => boolean;
  onEdit: (r: QuickReply) => void;
  onDelete: (r: QuickReply) => void;
}) {
  const { t } = useTranslation(['settingsQuickReplies', 'common']);
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((r) => (
            <li key={r.id} className="flex items-start gap-3 p-3">
              <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                /{r.shortcut}
              </code>
              <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {r.message_text}
              </p>
              {canModify(r) && (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onEdit(r)}
                    aria-label={t('editAria')}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onDelete(r)}
                    aria-label={t('deleteAria')}
                    className="text-muted-foreground hover:text-red-400"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
