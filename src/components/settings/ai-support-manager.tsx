'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, LifeBuoy, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
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
import type { AiSupportArticle } from '@/types';

/**
 * Gerencia a base de SUPORTE do agente (ai_support_articles). CRUD direto via
 * supabase + RLS admin. Exclusão SOFT (ativo=false). Molde: quick-replies.
 */
export function AiSupportManager() {
  const { t } = useTranslation(['settingsAiAgent', 'common']);
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [articles, setArticles] = useState<AiSupportArticle[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [categoria, setCategoria] = useState('');
  const [titulo, setTitulo] = useState('');
  const [conteudo, setConteudo] = useState('');
  const [keywords, setKeywords] = useState('');
  const [ativo, setAtivo] = useState(true);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<AiSupportArticle | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('ai_support_articles')
      .select('*')
      .order('categoria', { ascending: true });
    if (error) {
      toast.error(t('loadError'));
      setLoading(false);
      return;
    }
    setArticles((data as AiSupportArticle[]) ?? []);
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    fetchArticles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  function resetForm() {
    setEditingId(null);
    setCategoria('');
    setTitulo('');
    setConteudo('');
    setKeywords('');
    setAtivo(true);
  }

  function startEdit(a: AiSupportArticle) {
    setEditingId(a.id);
    setCategoria(a.categoria);
    setTitulo(a.titulo);
    setConteudo(a.conteudo);
    setKeywords(a.keywords ?? '');
    setAtivo(a.ativo);
  }

  async function handleSubmit() {
    if (!categoria.trim() || !titulo.trim() || !conteudo.trim()) {
      toast.error(t('requiredError'));
      return;
    }
    if (!accountId) {
      toast.error(t('notAuthenticated'));
      return;
    }
    setSaving(true);
    const payload = {
      categoria: categoria.trim(),
      titulo: titulo.trim(),
      conteudo: conteudo.trim(),
      keywords: keywords.trim() || null,
      ativo,
      atualizado_em: new Date().toISOString().slice(0, 10),
    };
    try {
      if (editingId) {
        const { error } = await supabase.from('ai_support_articles').update(payload).eq('id', editingId);
        if (error) throw error;
        toast.success(t('updatedToast'));
      } else {
        const { error } = await supabase.from('ai_support_articles').insert({ account_id: accountId, ...payload });
        if (error) throw error;
        toast.success(t('createdToast'));
      }
      resetForm();
      await fetchArticles();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      toast.error(code === '42501' ? t('adminOnly') : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  // Exclusão SOFT: desativa (ativo=false).
  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from('ai_support_articles').update({ ativo: false }).eq('id', deleteTarget.id);
    if (error) {
      toast.error((error as { code?: string })?.code === '42501' ? t('adminOnly') : t('deleteError'));
    } else {
      toast.success(t('deletedToast'));
      if (editingId === deleteTarget.id) resetForm();
      await fetchArticles();
    }
    setDeleting(false);
    setDeleteTarget(null);
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <LifeBuoy className="size-5 text-primary" />
          {t('supportTitle')}
        </CardTitle>
        <CardDescription>{t('supportDesc')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <div
          className={cn(
            'space-y-3 rounded-lg border bg-muted/30 p-4',
            editingId ? 'border-primary/60' : 'border-border',
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">
              {editingId ? `${t('editArticle')}${titulo ? ` — ${titulo}` : ''}` : t('newArticle')}
            </p>
            {editingId && (
              <button
                type="button"
                onClick={resetForm}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t('cancelEdit')}
              </button>
            )}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="sm:w-56">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('s_categoria')}</label>
              <Input value={categoria} onChange={(e) => setCategoria(e.target.value)} placeholder={t('s_categoriaPlaceholder')} className="border-border bg-background text-foreground" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('s_titulo')}</label>
              <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} className="border-border bg-background text-foreground" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('s_conteudo')}</label>
            <Textarea value={conteudo} onChange={(e) => setConteudo(e.target.value)} rows={4} className="border-border bg-background text-foreground" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('s_keywords')}</label>
            <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} className="border-border bg-background text-foreground" />
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
              {t('activeLabel')}
            </label>
            <Button onClick={handleSubmit} disabled={saving || !categoria.trim() || !titulo.trim() || !conteudo.trim()} className="ml-auto bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              {saving ? <Loader2 className="size-4 animate-spin" /> : editingId ? <Pencil className="size-4" /> : <Plus className="size-4" />}
              {editingId ? t('saveChanges') : t('addNew')}
            </Button>
            {editingId && (
              <Button variant="outline" onClick={resetForm} className="border-border text-muted-foreground">
                <X className="size-4" />
                {t('cancel', { ns: 'common' })}
              </Button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : articles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('s_empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {articles.map((a) => (
              <li key={a.id} className={cn('flex items-start gap-3 p-3', !a.ativo && 'opacity-50')}>
                <span className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{a.categoria}</span>
                <button type="button" onClick={() => startEdit(a)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-foreground">{a.titulo}</p>
                  <p className="truncate text-xs text-muted-foreground">{a.conteudo}</p>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => startEdit(a)} aria-label={t('editAria')} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDeleteTarget(a)} aria-label={t('deleteAria')} className="text-muted-foreground hover:text-red-400">
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('deleteTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteConfirmPrefix')}{' '}
              <span className="font-medium text-popover-foreground">{deleteTarget?.titulo}</span>
              {t('deleteConfirmSuffix')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} className="border-border text-muted-foreground">
              {t('cancel', { ns: 'common' })}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('delete', { ns: 'common' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
