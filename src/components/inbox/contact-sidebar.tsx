"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Contact, ContactNote, Tag } from "@/types";
import type { StudentInfoResponse } from "@/lib/integrations/student-info";
import { agrupaRedacoesPorBanca } from "@/lib/inbox/redacoes";
import { fundeCursos, agrupaCursosPorAno } from "@/lib/inbox/student-courses";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Phone,
  Mail,
  Copy,
  Check,
  Tag as TagIcon,
  StickyNote,
  GraduationCap,
  Loader2,
  Plus,
  X,
  Maximize2,
  Minimize2,
} from "lucide-react";

// Resposta da rota /api/integrations/student-info (panorama + flags de estado).
type StudentPanel = StudentInfoResponse & {
  configured?: boolean;
  stale?: boolean;
  fetched_at?: string;
};
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";

interface ContactSidebarProps {
  contact: Contact | null;
  /** Largura do painel. Default w-70 (desktop); overlay mobile passa w-full. */
  widthClassName?: string;
  /** Modo "destacado" (dentro do modal). Troca o ícone do botão. */
  expanded?: boolean;
  /** Se fornecido, mostra o botão de destacar/restaurar (só desktop). */
  onToggleExpand?: () => void;
  /** Reflete a edição inline no pai (activeContact) — passar nas 2 instâncias. */
  onContactUpdate?: (patch: Partial<Contact>) => void;
}

export function ContactSidebar({
  contact,
  widthClassName = "w-70",
  expanded,
  onToggleExpand,
  onContactUpdate,
}: ContactSidebarProps) {
  const { t } = useTranslation('inbox');
  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  // Todas as tags da conta (para o seletor "+"). RLS filtra por conta.
  const [accountTags, setAccountTags] = useState<Tag[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  // Cópia local dos campos editáveis; re-sincroniza ao trocar de contato.
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  useEffect(() => {
    // Re-sincroniza a cópia local só quando troca de contato (id), não a cada
    // tecla — por isso a dep é só contact?.id.
    setForm({
      name: contact?.name ?? "",
      phone: contact?.phone ?? "",
      email: contact?.email ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact?.id]);
  // Dados do Aluno (Millaborges) — busca ao vivo a cada abertura do contato.
  const [student, setStudent] = useState<StudentPanel | null>(null);
  const [loadingStudent, setLoadingStudent] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch notes, tags do contato e todas as tags da conta em paralelo.
    const [notesRes, tagsRes, accountTagsRes] = await Promise.all([
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
      // Todas as tags da conta (seletor "+"); RLS já isola por conta.
      supabase.from("tags").select("*").order("name"),
    ]);

    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
    if (accountTagsRes.data) setAccountTags(accountTagsRes.data as Tag[]);

    // Dados do Aluno: chama a rota proxy (server-to-server) a cada troca de contato.
    setLoadingStudent(true);
    try {
      const r = await fetch("/api/integrations/student-info", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactId: contact.id }),
      });
      setStudent((await r.json()) as StudentPanel);
    } catch {
      setStudent({ status: "erro" });
    } finally {
      setLoadingStudent(false);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  // Salva um campo do contato no blur, só se mudou. phone é NOT NULL → bloqueia
  // vazio. Espelha saveDetails() de contact-detail-view.tsx:216.
  const saveField = useCallback(
    async (field: "name" | "phone" | "email", value: string) => {
      if (!contact) return;
      const v = value.trim();
      if (field === "phone" && !v) {
        toast.error("Telefone é obrigatório");
        return;
      }
      const original = (contact[field] ?? "") as string;
      if (v === original) return; // nada mudou
      const patch = { [field]: field === "phone" ? v : v || null } as Partial<Contact>;
      const supabase = createClient();
      const { error } = await supabase
        .from("contacts")
        .update({ ...patch, updated_at: new Date().toISOString() })
        .eq("id", contact.id);
      if (error) {
        toast.error("Falha ao salvar");
        return;
      }
      toast.success("Contato atualizado");
      onContactUpdate?.(patch); // reflete no pai (activeContact)
    },
    [contact, onContactUpdate],
  );

  // Anexa/remove a tag do contato (contact_tags: existe→DELETE, senão INSERT).
  // Espelha toggleTag() de contact-detail-view.tsx:244.
  const toggleTag = useCallback(
    async (tag: Tag) => {
      if (!contact) return;
      const supabase = createClient();
      const has = tags.some((tt) => tt.id === tag.id);
      if (has) {
        await supabase
          .from("contact_tags")
          .delete()
          .eq("contact_id", contact.id)
          .eq("tag_id", tag.id);
        setTags((prev) => prev.filter((tt) => tt.id !== tag.id));
      } else {
        const { data } = await supabase
          .from("contact_tags")
          .insert({ contact_id: contact.id, tag_id: tag.id })
          .select("id")
          .single();
        setTags((prev) => [...prev, { ...tag, contact_tag_id: data?.id ?? "" }]);
      }
    },
    [contact, tags],
  );

  if (!contact) {
    return (
      <div className={`flex h-full ${widthClassName} items-center justify-center border-l border-border bg-card`}>
        <p className="text-sm text-muted-foreground">{t('selectConversation')}</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className={cn("relative flex h-full min-h-0 flex-col border-l border-border bg-card", widthClassName)}>
      {/* Destacar o painel num overlay (desktop). Ausente no overlay mobile
          (que não passa onToggleExpand). */}
      {onToggleExpand && (
        <button
          type="button"
          onClick={onToggleExpand}
          aria-label={expanded ? "Restaurar painel" : "Expandir painel"}
          title={expanded ? "Restaurar" : "Expandir"}
          className="absolute right-2 top-2 z-10 hidden h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:inline-flex"
        >
          {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            {/* Nome editável (input que parece texto; salva no blur). */}
            <input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              onBlur={(e) => saveField("name", e.target.value)}
              placeholder={contact.phone}
              className="mt-3 w-full rounded-md bg-transparent text-center text-sm font-semibold text-foreground outline-none hover:bg-muted focus:bg-muted focus:ring-1 focus:ring-primary/50"
            />
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Telefone (editável) + Email (editável) */}
          <div className="mt-4 space-y-2">
            <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground focus-within:bg-muted hover:bg-muted">
              <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                onBlur={(e) => saveField("phone", e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
              />
              <button
                onClick={handleCopyPhone}
                aria-label="Copiar telefone"
                className="shrink-0"
              >
                {copied ? (
                  <Check className="h-3 w-3 text-primary" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
            </div>

            <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted-foreground focus-within:bg-muted hover:bg-muted">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                onBlur={(e) => saveField("email", e.target.value)}
                placeholder={t("addEmail")}
                type="email"
                className="min-w-0 flex-1 bg-transparent text-foreground outline-none"
              />
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags (editáveis) */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              Tags
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
              {tags.map((tag) => (
                <button
                  key={tag.contact_tag_id}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  className="group inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                  title="Remover tag"
                >
                  {tag.name}
                  <X className="h-2.5 w-2.5 opacity-60 group-hover:opacity-100" />
                </button>
              ))}
              {/* Seletor "+" — abre a lista de tags da conta para toggle. */}
              <Popover>
                <PopoverTrigger
                  aria-label={t("addTag")}
                  title={t("addTag")}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground hover:bg-muted"
                >
                  <Plus className="h-3 w-3" />
                </PopoverTrigger>
                <PopoverContent align="start" className="w-56 p-2">
                  {accountTags.length === 0 ? (
                    <p className="px-1 py-1 text-xs text-muted-foreground">
                      {t("noTags")}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {accountTags.map((tag) => {
                        const selected = tags.some((tt) => tt.id === tag.id);
                        return (
                          <button
                            key={tag.id}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-all",
                              selected
                                ? "ring-2 ring-primary ring-offset-1 ring-offset-popover"
                                : "opacity-60 hover:opacity-100"
                            )}
                            style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                          >
                            {tag.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Dados do Aluno (Millaborges) */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <GraduationCap className="h-3 w-3" />
              Dados do Aluno
            </div>
            <div className="mt-2">
              <StudentBlock student={student} loading={loadingStudent} />
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              {t("notes")}
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder={t('addNote')}
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// Formata "2026-06-18 22:04:23" → "18/06/2026". Tolera valor vazio/ inválido.
function fmtDate(d?: string): string {
  if (!d) return "—";
  const dt = new Date(d.replace(" ", "T"));
  return Number.isNaN(dt.getTime()) ? d : format(dt, "dd/MM/yyyy");
}

// Barra de progresso simples (não há componente Progress no projeto).
function Bar({ pct }: { pct: number }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted-foreground/15">
      <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${v}%` }} />
    </div>
  );
}

// Renderiza o painel "Dados do Aluno" conforme o status da rota.
function StudentBlock({
  student,
  loading,
}: {
  student: StudentPanel | null;
  loading: boolean;
}) {
  if (loading && !student) {
    return (
      <div className="flex justify-center py-3">
        <Loader2 className="size-4 animate-spin text-primary" />
      </div>
    );
  }
  if (!student || student.configured === false) {
    return null; // integração não configurada → bloco discreto (some)
  }
  if (student.status === "no_identifier")
    return <p className="px-1 text-xs text-muted-foreground">Contato sem email/telefone.</p>;
  if (student.status === "nao_encontrado")
    return <p className="px-1 text-xs text-muted-foreground">Não é aluno.</p>;
  if (student.status === "erro")
    return <p className="px-1 text-xs text-muted-foreground">Não foi possível carregar.</p>;
  if (student.status === "multiplos")
    return (
      <div className="space-y-1">
        <p className="px-1 text-xs text-muted-foreground">Vários alunos com esse telefone:</p>
        {(student.candidatos ?? []).map((c) => (
          <div key={c.id} className="rounded-lg bg-muted px-3 py-1.5 text-xs">
            <p className="font-medium text-foreground">{c.nome}</p>
            <p className="text-muted-foreground">{c.email}</p>
          </div>
        ))}
      </div>
    );
  if (student.status !== "success" || !student.aluno) return null;

  const a = student.aluno;
  const prog = student.progresso_aulas;
  return (
    <div className="space-y-3 text-xs">
      {student.stale && (
        <p className="text-[10px] text-amber-400">
          Dados de {fmtDate(student.fetched_at)} (offline)
        </p>
      )}
      {/* Cadastro */}
      <div className="rounded-lg bg-muted px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="font-medium text-foreground">{a.nome}</span>
          <span
            className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: a.vigente === "S" ? "#10b98120" : "#ef444420",
              color: a.vigente === "S" ? "#10b981" : "#ef4444",
            }}
          >
            {a.vigente === "S" ? "Ativo" : "Inativo"}
          </span>
        </div>
        <p className="mt-1 text-muted-foreground">Email: {a.email || "—"}</p>
        <p className="text-muted-foreground">Nasc.: {fmtDate(a.data_nascimento)}</p>
      </div>

      {/* Cursos fundidos, agrupados por ano da matrícula. Ano vigente expandido,
          anteriores colapsados (<details> nativo). */}
      {(() => {
        // Binding local — fusão e agrupamento moram na lib pura.
        const cursos = fundeCursos(student.cursos_matriculados, prog);
        const grupos = agrupaCursosPorAno(cursos);
        const anoAtual = new Date().getFullYear();
        return (
          <div>
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                Cursos
              </span>
              {prog && <span className="text-foreground">{Math.round(prog.percentual_geral)}%</span>}
            </div>
            {grupos.length === 0 ? (
              <p className="px-1 text-muted-foreground">Sem curso ativo.</p>
            ) : (
              <div className="space-y-1">
                {grupos.map((g) => (
                  <details key={g.ano ?? "sem-ano"} open={g.ano === anoAtual}>
                    <summary className="cursor-pointer list-none px-1 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {g.ano ?? "Sem data"} · {g.cursos.length} curso{g.cursos.length > 1 ? "s" : ""}
                    </summary>
                    <div className="mt-1 space-y-1.5">
                      {g.cursos.map((curso) => (
                        <div key={curso.id_curso} className="rounded-lg bg-muted px-3 py-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate font-medium text-foreground">{curso.nome_curso}</span>
                            {curso.progresso && (
                              <span className="shrink-0 text-muted-foreground">
                                {curso.progresso.aulas_concluidas}/{curso.progresso.total_aulas} aulas
                              </span>
                            )}
                          </div>
                          <p className="text-muted-foreground">
                            Matrícula: {fmtDate(curso.data_matricula ?? undefined)}
                            {curso.tag ? ` · ${curso.tag}` : ""}
                          </p>
                          {curso.progresso && (
                            <>
                              {/* Barra = % de aulas concluídas (rotulada p/ não confundir com vídeo). */}
                              <div className="mt-1 flex items-center gap-2">
                                <div className="flex-1">
                                  <Bar pct={curso.progresso.percentual_concluidas} />
                                </div>
                                <span className="shrink-0 text-[10px] text-muted-foreground">
                                  {Math.round(curso.progresso.percentual_concluidas)}% aulas
                                </span>
                              </div>
                              <p className="mt-0.5 text-[10px] text-muted-foreground">
                                Vídeo assistido: {Math.round(curso.progresso.media_video_assistido)}%
                              </p>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </div>
        );
      })()}

      {/* Redações do ano atual, agrupadas por banca (ENEM/UERJ/FUVEST/…). */}
      {student.redacoes && (() => {
        // Só binding local + JSX — a agregação (filter/reduce/sort) mora na lib pura.
        const ano = new Date().getFullYear();
        const bancas = agrupaRedacoesPorBanca(student.redacoes, ano);
        return (
          <div className="px-1 text-muted-foreground">
            <p className="mb-0.5 text-[10px] font-medium uppercase tracking-wider">
              Redações {ano}
            </p>
            {bancas.length === 0 ? (
              <p>Nenhuma redação em {ano}.</p>
            ) : (
              <p>
                {bancas.map(([banca, n], i) => (
                  <span key={banca}>
                    {i > 0 ? " · " : ""}
                    {banca}: <span className="text-foreground">{n}</span>
                  </span>
                ))}
              </p>
            )}
          </div>
        );
      })()}
    </div>
  );
}
