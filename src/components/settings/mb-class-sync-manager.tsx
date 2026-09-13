'use client';

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { AlertTriangle, GraduationCap, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MbClassSyncPair, MbCourseOption } from '@/types';

/**
 * De→para curso da Plataforma MB × tag (admin). O cron horário (/api/mb-sync/cron)
 * reconcilia cada tag com os alunos ativos dos cursos ligados a ela.
 */
export function MbClassSyncManager() {
  const { t } = useTranslation(['settingsMbClasses', 'common']);
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [pairs, setPairs] = useState<MbClassSyncPair[]>([]);
  const [courseInput, setCourseInput] = useState('');
  const [course, setCourse] = useState<MbCourseOption | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [tags, setTags] = useState<{ id: string; name: string }[]>([]);
  const [tagId, setTagId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toDelete, setToDelete] = useState<MbClassSyncPair | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Pares da conta (a API aplica requireRole('admin')).
  async function loadPairs() {
    const res = await fetch('/api/integrations/mb-class-sync', { cache: 'no-store' });
    if (!res.ok) throw new Error(t('loadError'));
    setPairs(((await res.json()).pairs ?? []) as MbClassSyncPair[]);
  }

  useEffect(() => {
    if (authLoading || !accountId) return;
    (async () => {
      try {
        const [, tagsRes] = await Promise.all([
          loadPairs(),
          supabase.from('tags').select('id, name').eq('account_id', accountId).order('name'),
        ]);
        setTags((tagsRes.data ?? []) as { id: string; name: string }[]);
      } catch (err) {
        toast.error((err as Error).message || t('loadError'));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accountId]);

  // Confere o curso na Plataforma MB pelo id (a API não lista cursos).
  async function handleLookup() {
    const id = courseInput.trim();
    if (!/^\d+$/.test(id)) return;
    setLookingUp(true);
    setCourse(null);
    try {
      const res = await fetch(`/api/integrations/mb-class-sync/course?id=${id}`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || t('lookupError'));
      setCourse(body.course as MbCourseOption);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLookingUp(false);
    }
  }

  // Cria o par com o curso conferido; 409 = já existe.
  async function handleAdd() {
    if (!course || !tagId) return;
    setSaving(true);
    try {
      const res = await fetch('/api/integrations/mb-class-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mb_course_id: course.id_curso,
          mb_course_name: course.nome_curso,
          tag_id: tagId,
        }),
      });
      if (res.status === 409) {
        toast.error(t('duplicate'));
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || t('saveError'));
      }
      toast.success(t('added'));
      setCourse(null);
      setCourseInput('');
      setTagId(null);
      await loadPairs();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // Remove o par confirmado no Dialog.
  async function handleDelete() {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/integrations/mb-class-sync?id=${toDelete.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(t('saveError'));
      toast.success(t('removed'));
      setToDelete(null);
      await loadPairs();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setDeleting(false);
    }
  }

  const tagLabel = (id: string | null) => tags.find((x) => x.id === id)?.name ?? t('selectTag');

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <GraduationCap className="size-5" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertDescription>{t('warning')}</AlertDescription>
        </Alert>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                inputMode="numeric"
                placeholder={t('courseId')}
                value={courseInput}
                onChange={(e) => {
                  setCourseInput(e.target.value.replace(/\D/g, ''));
                  setCourse(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
                className="w-32 border-border bg-background text-foreground"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleLookup}
                disabled={lookingUp || !courseInput}
              >
                {lookingUp ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
                {t('lookup')}
              </Button>

              <Select value={tagId} onValueChange={(v) => v && setTagId(v as string)}>
                <SelectTrigger className="w-56 border-border bg-background text-foreground">
                  <SelectValue>{(v: string | null) => tagLabel(v)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tags.map((tg) => (
                    <SelectItem key={tg.id} value={tg.id}>
                      {tg.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant="outline"
                size="sm"
                onClick={handleAdd}
                disabled={saving || !course || !tagId}
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                {t('add')}
              </Button>
            </div>

            {course && (
              <p className="text-sm text-muted-foreground">
                {t('courseFound', { name: course.nome_curso, count: course.total_ativos })}
                {course.vigente !== 'S' && ` · ${t('courseClosed')}`}
              </p>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('course')}</TableHead>
                  <TableHead>{t('tag')}</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {pairs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      {t('empty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  pairs.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{p.mb_course_name ?? `#${p.mb_course_id}`}</TableCell>
                      <TableCell>{p.tag?.name ?? '—'}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('remove')}
                          onClick={() => setToDelete(p)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>

      <Dialog open={!!toDelete} onOpenChange={(o) => !o && setToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('removeTitle')}</DialogTitle>
            <DialogDescription>{t('removeDesc')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setToDelete(null)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
