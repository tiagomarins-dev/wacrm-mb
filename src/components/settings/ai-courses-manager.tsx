'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, GraduationCap, X } from 'lucide-react';
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
import type { AiCourse } from '@/types';

/**
 * Gerencia a base de CURSOS do agente (ai_courses). CRUD direto via supabase +
 * RLS admin. Exclusão é SOFT (ativo=false) — preserva histórico/links.
 * Molde: quick-replies-manager.tsx.
 */
export function AiCoursesManager() {
  const { t } = useTranslation(['settingsAiAgent', 'common']);
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [courses, setCourses] = useState<AiCourse[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [slug, setSlug] = useState('');
  const [nome, setNome] = useState('');
  const [condicao, setCondicao] = useState('');
  const [link, setLink] = useState('');
  const [posicionamento, setPosicionamento] = useState('');
  const [entregas, setEntregas] = useState('');
  const [garantia, setGarantia] = useState('');
  const [naoProm, setNaoProm] = useState('');
  const [ativo, setAtivo] = useState(true);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<AiCourse | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchCourses = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('ai_courses')
      .select('*')
      .order('nome', { ascending: true });
    if (error) {
      toast.error(t('loadError'));
      setLoading(false);
      return;
    }
    setCourses((data as AiCourse[]) ?? []);
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    fetchCourses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  function resetForm() {
    setEditingId(null);
    setSlug('');
    setNome('');
    setCondicao('');
    setLink('');
    setPosicionamento('');
    setEntregas('');
    setGarantia('');
    setNaoProm('');
    setAtivo(true);
  }

  function startEdit(c: AiCourse) {
    setEditingId(c.id);
    setSlug(c.slug);
    setNome(c.nome);
    setCondicao(c.condicao_vigente ?? '');
    setLink(c.link_venda ?? '');
    setPosicionamento(c.posicionamento ?? '');
    setEntregas(c.entregas ?? '');
    setGarantia(c.garantia ?? '');
    setNaoProm(c.nao_prometer ?? '');
    setAtivo(c.ativo);
  }

  async function handleSubmit() {
    if (!slug.trim() || !nome.trim()) {
      toast.error(t('requiredError'));
      return;
    }
    if (!accountId) {
      toast.error(t('notAuthenticated'));
      return;
    }
    setSaving(true);
    const payload = {
      slug: slug.trim(),
      nome: nome.trim(),
      condicao_vigente: condicao.trim() || null,
      link_venda: link.trim() || null,
      posicionamento: posicionamento.trim() || null,
      entregas: entregas.trim() || null,
      garantia: garantia.trim() || null,
      nao_prometer: naoProm.trim() || null,
      ativo,
      atualizado_em: new Date().toISOString().slice(0, 10),
    };
    try {
      if (editingId) {
        const { error } = await supabase.from('ai_courses').update(payload).eq('id', editingId);
        if (error) throw error;
        toast.success(t('updatedToast'));
      } else {
        const { error } = await supabase.from('ai_courses').insert({ account_id: accountId, ...payload });
        if (error) throw error;
        toast.success(t('createdToast'));
      }
      resetForm();
      await fetchCourses();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      toast.error(code === '23505' ? t('duplicate') : code === '42501' ? t('adminOnly') : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  // Exclusão SOFT: desativa (ativo=false) em vez de apagar.
  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from('ai_courses').update({ ativo: false }).eq('id', deleteTarget.id);
    if (error) {
      toast.error((error as { code?: string })?.code === '42501' ? t('adminOnly') : t('deleteError'));
    } else {
      toast.success(t('deletedToast'));
      if (editingId === deleteTarget.id) resetForm();
      await fetchCourses();
    }
    setDeleting(false);
    setDeleteTarget(null);
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <GraduationCap className="size-5 text-primary" />
          {t('coursesTitle')}
        </CardTitle>
        <CardDescription>{t('coursesDesc')}</CardDescription>
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
              {editingId ? `${t('editCourse')}${nome ? ` — ${nome}` : ''}` : t('newCourse')}
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
            <div className="sm:w-72">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_slug')}</label>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t('c_slugPlaceholder')} className="border-border bg-background font-mono text-xs text-foreground" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_name')}</label>
              <Input value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t('c_namePlaceholder')} className="border-border bg-background text-foreground" />
            </div>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_condicao')}</label>
              <Input value={condicao} onChange={(e) => setCondicao(e.target.value)} placeholder={t('c_condicaoPlaceholder')} className="border-border bg-background text-foreground" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_link')}</label>
              <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://pay.hotmart.com/..." className="border-border bg-background font-mono text-xs text-foreground" />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_posicionamento')}</label>
            <Textarea value={posicionamento} onChange={(e) => setPosicionamento(e.target.value)} rows={2} className="border-border bg-background text-foreground" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_entregas')}</label>
            <Textarea value={entregas} onChange={(e) => setEntregas(e.target.value)} rows={2} className="border-border bg-background text-foreground" />
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_garantia')}</label>
              <Input value={garantia} onChange={(e) => setGarantia(e.target.value)} className="border-border bg-background text-foreground" />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('c_naoProm')}</label>
              <Input value={naoProm} onChange={(e) => setNaoProm(e.target.value)} className="border-border bg-background text-foreground" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
              {t('activeLabel')}
            </label>
            <Button onClick={handleSubmit} disabled={saving || !slug.trim() || !nome.trim()} className="ml-auto bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
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
        ) : courses.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('c_empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {courses.map((c) => (
              <li key={c.id} className={cn('flex items-start gap-3 p-3', !c.ativo && 'opacity-50')}>
                <code className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-foreground">{c.slug}</code>
                <button type="button" onClick={() => startEdit(c)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-foreground">{c.nome}</p>
                  <p className="truncate text-xs text-muted-foreground">{c.condicao_vigente}</p>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => startEdit(c)} aria-label={t('editAria')} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDeleteTarget(c)} aria-label={t('deleteAria')} className="text-muted-foreground hover:text-red-400">
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
              <span className="font-medium text-popover-foreground">{deleteTarget?.nome}</span>
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
