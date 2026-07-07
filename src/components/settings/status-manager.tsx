'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CircleDot, Loader2, Lock, Plus, X } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import type { ConversationStatusRow } from '@/types';

// Paleta fixa (espelha tag-manager.tsx:28-37).
const PRESET_COLORS = [
  { name: 'Vermelho', value: '#ef4444' },
  { name: 'Laranja', value: '#f97316' },
  { name: 'Âmbar', value: '#f59e0b' },
  { name: 'Verde', value: '#10b981' },
  { name: 'Ciano', value: '#06b6d4' },
  { name: 'Azul', value: '#3b82f6' },
  { name: 'Violeta', value: '#8b5cf6' },
  { name: 'Rosa', value: '#ec4899' },
];

// Gera uma key estável (slug) a partir do rótulo do status custom.
function slugify(label: string): string {
  return label.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'status';
}

/**
 * Status de conversa — rótulos coloridos por conta. Os 3 de sistema
 * (open/pending/closed) têm label+cor editáveis mas key/delete travados
 * (trigger no banco reforça, mig 062). Custom têm CRUD completo; deletar
 * exige que nenhuma conversa use o status.
 */
export function StatusManager() {
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<ConversationStatusRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState(PRESET_COLORS[5].value);
  const [deleteDialog, setDeleteDialog] = useState<ConversationStatusRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (authLoading) return;
    if (!accountId) {
      setLoading(false);
      return;
    }
    fetchRows(accountId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, accountId]);

  async function fetchRows(acc: string) {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from('conversation_statuses')
        .select('*')
        .eq('account_id', acc)
        .order('sort_order', { ascending: true });
      if (error) throw error;
      setRows(data ?? []);
    } catch {
      toast.error('Falha ao carregar status');
    } finally {
      setLoading(false);
    }
  }

  // Atualiza label/cor de um status existente (system ou custom).
  async function patchRow(id: string, patch: Partial<Pick<ConversationStatusRow, 'label' | 'color'>>) {
    const { error } = await supabase.from('conversation_statuses').update(patch).eq('id', id);
    if (error) {
      toast.error('Falha ao atualizar status');
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function handleCreate() {
    const label = newLabel.trim();
    if (!label) {
      toast.error('Nome do status é obrigatório');
      return;
    }
    if (!accountId) {
      toast.error('Não autenticado');
      return;
    }
    // key única por conta; sort_order ao fim.
    const key = slugify(label);
    if (rows.some((r) => r.key === key)) {
      toast.error('Já existe um status com esse nome');
      return;
    }
    const sort_order = rows.reduce((m, r) => Math.max(m, r.sort_order), 0) + 1;
    try {
      setSaving(true);
      const { data, error } = await supabase.from('conversation_statuses').insert({
        account_id: accountId, key, label, color: newColor, is_system: false, sort_order,
      }).select('*').single();
      if (error) throw error;
      toast.success('Status criado');
      setNewLabel('');
      setNewColor(PRESET_COLORS[5].value);
      if (data) setRows((prev) => [...prev, data]);
    } catch (err) {
      // 42501 = RLS (só admin cria).
      const code = (err as { code?: string })?.code;
      toast.error(code === '42501' ? 'Só admins podem gerenciar status.' : 'Falha ao criar status');
    } finally {
      setSaving(false);
    }
  }

  // Delete guard: bloqueia se houver conversa usando o status.
  async function confirmDelete(row: ConversationStatusRow) {
    if (!accountId) return;
    const { count } = await supabase
      .from('conversations')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
      .eq('status', row.key);
    if ((count ?? 0) > 0) {
      toast.error(`${count} conversa(s) usam "${row.label}". Reatribua antes de excluir.`);
      return;
    }
    setDeleteDialog(row);
  }

  async function handleDelete() {
    if (!deleteDialog) return;
    try {
      setDeleting(true);
      const { error } = await supabase.from('conversation_statuses').delete().eq('id', deleteDialog.id);
      if (error) throw error;
      toast.success('Status excluído');
      setRows((prev) => prev.filter((r) => r.id !== deleteDialog.id));
      setDeleteDialog(null);
    } catch {
      toast.error('Falha ao excluir status');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <CircleDot className="size-4 text-primary" />
          Status de conversa
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Rótulos coloridos das conversas. Os 3 padrão (Aberta/Pendente/Finalizada) têm
          nome e cor editáveis; crie novos para o seu fluxo.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border px-3 py-2"
                >
                  {/* Preview do badge */}
                  <span
                    className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium"
                    style={{ backgroundColor: `${row.color}20`, color: row.color }}
                  >
                    {row.label || '—'}
                  </span>
                  {/* Editar rótulo (blur salva) */}
                  <Input
                    defaultValue={row.label}
                    maxLength={40}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== row.label) patchRow(row.id, { label: v });
                    }}
                    className="h-8 min-w-[140px] flex-1"
                  />
                  {/* Swatches de cor (clique salva) */}
                  <div className="flex gap-1.5">
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c.value}
                        type="button"
                        onClick={() => patchRow(row.id, { color: c.value })}
                        aria-label={`Usar ${c.name}`}
                        aria-pressed={row.color === c.value}
                        className={cn(
                          'size-5 rounded-md transition-transform hover:scale-110',
                          row.color === c.value && 'outline outline-2 outline-offset-2 outline-primary',
                        )}
                        style={{ backgroundColor: c.value }}
                        title={c.name}
                      />
                    ))}
                  </div>
                  {/* System: cadeado (key/delete travados). Custom: excluir. */}
                  {row.is_system ? (
                    <span className="flex items-center gap-1 text-[10px] text-muted-foreground" title="Status de sistema">
                      <Lock className="size-3" /> sistema
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => confirmDelete(row)}
                      aria-label={`Excluir ${row.label}`}
                      className="rounded-full p-1 opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Criar status custom */}
            <div className="flex flex-wrap items-center gap-2.5 border-t border-border pt-4">
              <Input
                placeholder="Ex.: Aguardando pagamento"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreate();
                }}
                disabled={saving}
                maxLength={40}
                className="min-w-[180px] flex-1"
              />
              <div className="flex gap-1.5">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c.value}
                    type="button"
                    onClick={() => setNewColor(c.value)}
                    aria-label={`Usar ${c.name}`}
                    aria-pressed={newColor === c.value}
                    className={cn(
                      'size-6 rounded-md transition-transform hover:scale-110',
                      newColor === c.value && 'outline outline-2 outline-offset-2 outline-primary',
                    )}
                    style={{ backgroundColor: c.value }}
                    title={c.name}
                  />
                ))}
              </div>
              <Button variant="outline" size="sm" onClick={handleCreate} disabled={saving || !newLabel.trim()}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Criar status
              </Button>
            </div>
          </>
        )}
      </CardContent>

      {/* Confirmação de exclusão */}
      <Dialog open={!!deleteDialog} onOpenChange={(o) => !o && setDeleteDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir status</DialogTitle>
            <DialogDescription>
              Excluir o status &quot;{deleteDialog?.label}&quot;? Esta ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteDialog(null)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
              {deleting ? <><Loader2 className="size-4 animate-spin" /> Excluindo...</> : 'Excluir status'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
