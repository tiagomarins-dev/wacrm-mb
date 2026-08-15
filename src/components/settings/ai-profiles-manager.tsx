'use client';

import { useEffect, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, Plus, Pencil, Trash2, Bot, X } from 'lucide-react';
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
import type { AiProfile, ReportMember } from '@/types';

// Tools de domínio liberáveis por perfil (as de controle entram sempre no engine).
const DOMAIN_TOOLS = ['get_curso', 'enviar_link_venda', 'buscar_suporte'] as const;
const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.6';

// Assuntos que a tool transferir_humano sabe rotear. As chaves batem com o que
// tools.ts:232 lê de handoff_routing — mudar aqui sem mudar lá quebra a rota.
const HANDOFF_TOPICS = ['vendas', 'suporte'] as const;
type HandoffTopic = (typeof HANDOFF_TOPICS)[number];

// Valor do <option> que representa "não roteia para ninguém". String vazia porque
// o select devolve string; vira ausência da chave no JSONB, que o engine trata
// como desatribuir a conversa (cai na fila).
const FILA = '';

/**
 * Gerencia os perfis de IA (responsáveis atribuíveis). Lê a tabela BASE
 * ai_profiles (admin → persona), CRUD direto via supabase + RLS admin.
 * Molde: quick-replies-manager.tsx.
 */
export function AiProfilesManager() {
  const { t } = useTranslation(['settingsAiAgent', 'common']);
  const supabase = createClient();
  const { accountId, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<AiProfile[]>([]);

  // Form (cria ou edita). editingId != null = edição.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nome, setNome] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [persona, setPersona] = useState('');
  const [maxTurns, setMaxTurns] = useState(8);
  const [tools, setTools] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  // Destino da transferência por assunto. Guarda user_id ou FILA.
  const [routing, setRouting] = useState<Record<HandoffTopic, string>>({ vendas: FILA, suporte: FILA });
  // Membros da conta que podem receber uma conversa. Viewer fica de fora: não atende.
  const [members, setMembers] = useState<ReportMember[]>([]);

  const [deleteTarget, setDeleteTarget] = useState<AiProfile | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('ai_profiles')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) {
      toast.error(t('loadError'));
      setLoading(false);
      return;
    }
    setProfiles((data as AiProfile[]) ?? []);
    setLoading(false);
  }, [supabase, t]);

  useEffect(() => {
    if (authLoading) return;
    fetchProfiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading]);

  // Membros para os selects de transferência. Mesma fonte da tela de relatórios
  // (reports/page.tsx:64). Viewer não entra: não assume conversa.
  useEffect(() => {
    if (authLoading) return;
    (async () => {
      const res = await fetch('/api/account/members', { cache: 'no-store' });
      if (!res.ok) return;
      const json = (await res.json()) as { members: ReportMember[] };
      setMembers(json.members.filter((m) => m.account_role !== 'viewer'));
    })();
  }, [authLoading]);

  function resetForm() {
    setEditingId(null);
    setNome('');
    setModel(DEFAULT_MODEL);
    setPersona('');
    setMaxTurns(8);
    setTools([]);
    setEnabled(true);
    setRouting({ vendas: FILA, suporte: FILA });
  }

  function startEdit(p: AiProfile) {
    setEditingId(p.id);
    setNome(p.nome);
    setModel(p.model);
    setPersona(p.persona_prompt ?? '');
    setMaxTurns(p.max_bot_turns);
    setTools(p.allowed_tools ?? []);
    setEnabled(p.enabled);
    setRouting({
      vendas: p.handoff_routing?.vendas ?? FILA,
      suporte: p.handoff_routing?.suporte ?? FILA,
    });
  }

  function toggleTool(tool: string) {
    setTools((prev) => (prev.includes(tool) ? prev.filter((x) => x !== tool) : [...prev, tool]));
  }

  async function handleSubmit() {
    if (!nome.trim()) {
      toast.error(t('requiredError'));
      return;
    }
    if (!accountId) {
      toast.error(t('notAuthenticated'));
      return;
    }
    setSaving(true);
    // Vazio = todas as tools de domínio (null no banco).
    const allowed_tools = tools.length ? tools : null;
    // Só entram os assuntos com destino escolhido: chave ausente faz a tool devolver
    // null e o engine desatribuir a conversa (fila). Objeto vazio vira null para o
    // banco ficar consistente com perfil que nunca configurou rota.
    const rota: Record<string, string> = {};
    for (const topico of HANDOFF_TOPICS) {
      if (routing[topico]) rota[topico] = routing[topico];
    }
    const handoff_routing = Object.keys(rota).length ? rota : null;
    const payload = {
      nome: nome.trim(),
      model: model.trim() || DEFAULT_MODEL,
      persona_prompt: persona.trim() || null,
      max_bot_turns: maxTurns,
      allowed_tools,
      handoff_routing,
      enabled,
    };
    try {
      if (editingId) {
        const { error } = await supabase.from('ai_profiles').update(payload).eq('id', editingId);
        if (error) throw error;
        toast.success(t('updatedToast'));
      } else {
        const { error } = await supabase
          .from('ai_profiles')
          .insert({ account_id: accountId, ...payload });
        if (error) throw error;
        toast.success(t('createdToast'));
      }
      resetForm();
      await fetchProfiles();
    } catch (err) {
      const code = (err as { code?: string })?.code;
      toast.error(code === '42501' ? t('adminOnly') : t('saveError'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    const { error } = await supabase.from('ai_profiles').delete().eq('id', deleteTarget.id);
    if (error) {
      toast.error((error as { code?: string })?.code === '42501' ? t('adminOnly') : t('deleteError'));
    } else {
      toast.success(t('deletedToast'));
      if (editingId === deleteTarget.id) resetForm();
      await fetchProfiles();
    }
    setDeleting(false);
    setDeleteTarget(null);
  }

  return (
    <Card className="border-border bg-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Bot className="size-5 text-primary" />
          {t('profilesTitle')}
        </CardTitle>
        <CardDescription>{t('profilesDesc')}</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Form: criar ou editar — o cabeçalho + a borda deixam o estado claro. */}
        <div
          className={cn(
            'space-y-3 rounded-lg border bg-muted/30 p-4',
            editingId ? 'border-primary/60' : 'border-border',
          )}
        >
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-foreground">
              {editingId ? `${t('editProfile')}${nome ? ` — ${nome}` : ''}` : t('newProfile')}
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
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('p_name')}</label>
              <Input
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                placeholder={t('p_namePlaceholder')}
                className="border-border bg-background text-foreground"
              />
            </div>
            <div className="sm:w-72">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('p_model')}</label>
              <Input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t('p_modelPlaceholder')}
                className="border-border bg-background font-mono text-xs text-foreground"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('p_persona')}</label>
            <Textarea
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              placeholder={t('p_personaPlaceholder')}
              rows={5}
              className="border-border bg-background text-foreground"
            />
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('p_tools')}</label>
              <div className="flex flex-wrap gap-2">
                {DOMAIN_TOOLS.map((tool) => (
                  <Button
                    key={tool}
                    type="button"
                    variant={tools.includes(tool) ? 'default' : 'outline'}
                    onClick={() => toggleTool(tool)}
                    className={cn(
                      'h-8 text-xs',
                      tools.includes(tool)
                        ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                        : 'border-border text-muted-foreground',
                    )}
                  >
                    {t(`tool_${tool}`)}
                  </Button>
                ))}
              </div>
              <p className={cn('mt-1 text-[11px]', tools.length === 0 ? 'text-emerald-500' : 'text-muted-foreground')}>
                {tools.length === 0 ? t('p_toolsAll') : t('p_toolsHint')}
              </p>
            </div>
            <div className="w-28">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('p_maxTurns')}</label>
              <Input
                type="number"
                min={1}
                max={20}
                value={maxTurns}
                onChange={(e) => setMaxTurns(Number(e.target.value) || 8)}
                className="border-border bg-background text-foreground"
              />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm text-foreground">
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {t('enabledLabel')}
            </label>
          </div>

          {/* Destino da transferência por assunto: a IA escolhe vendas ou suporte ao
              chamar transferir_humano, e a conversa é reatribuída a quem estiver aqui. */}
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">{t('p_handoff')}</label>
            <div className="flex flex-col gap-3 sm:flex-row">
              {HANDOFF_TOPICS.map((topico) => {
                const valor = routing[topico];
                // Destino que não está mais entre os membros (saiu da conta): mantém a
                // opção visível para o save não apagar a rota sem ninguém perceber.
                const orfao = valor && !members.some((m) => m.user_id === valor);
                return (
                  <div key={topico} className="flex-1">
                    <span className="mb-1 block text-[11px] text-muted-foreground">
                      {t(`p_handoff_${topico}`)}
                    </span>
                    <select
                      value={valor}
                      onChange={(e) => setRouting((prev) => ({ ...prev, [topico]: e.target.value }))}
                      className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                    >
                      <option value={FILA}>{t('p_handoffQueue')}</option>
                      {members.map((m) => (
                        <option key={m.user_id} value={m.user_id}>
                          {m.full_name || m.user_id.slice(0, 8)}
                        </option>
                      ))}
                      {orfao && (
                        <option value={valor}>{t('p_handoffUnknown', { id: valor.slice(0, 8) })}</option>
                      )}
                    </select>
                  </div>
                );
              })}
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">{t('p_handoffHint')}</p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              onClick={handleSubmit}
              disabled={saving || !nome.trim()}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
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

        {/* List */}
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : profiles.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('p_empty')}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {profiles.map((p) => (
              <li key={p.id} className="flex items-start gap-3 p-3">
                <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
                {/* Clicar no perfil abre a edição (preenche o form acima). */}
                <button type="button" onClick={() => startEdit(p)} className="min-w-0 flex-1 text-left">
                  <p className="truncate text-sm font-medium text-foreground">
                    {p.nome}
                    {!p.enabled && <span className="ml-2 text-xs text-muted-foreground">({t('enabledLabel')}: ✗)</span>}
                  </p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">{p.model}</p>
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-sm" onClick={() => startEdit(p)} aria-label={t('editAria')} className="text-muted-foreground hover:text-foreground">
                    <Pencil className="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => setDeleteTarget(p)} aria-label={t('deleteAria')} className="text-muted-foreground hover:text-red-400">
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
