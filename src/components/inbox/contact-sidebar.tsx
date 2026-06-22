"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Contact, Deal, ContactNote, Tag } from "@/types";
import type { StudentInfoResponse } from "@/lib/integrations/student-info";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  GraduationCap,
  Loader2,
  Plus,
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
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  // Dados do Aluno (Millaborges) — busca ao vivo a cada abertura do contato.
  const [student, setStudent] = useState<StudentPanel | null>(null);
  const [loadingStudent, setLoadingStudent] = useState(false);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, notes, and tags in parallel
    const [dealsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
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

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Select a conversation</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full min-h-0 w-70 flex-col border-l border-border bg-card">
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
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              Tags
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No tags</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              Active Deals
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No deals</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
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
              Notes
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
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
        <p className="mt-1 text-muted-foreground">CPF: {a.cpf || "—"}</p>
        <p className="text-muted-foreground">Nasc.: {fmtDate(a.data_nascimento)}</p>
      </div>

      {/* Cursos matriculados */}
      <div>
        <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Cursos
        </p>
        {(student.cursos_matriculados ?? []).length === 0 ? (
          <p className="px-1 text-muted-foreground">Sem curso ativo.</p>
        ) : (
          <div className="space-y-1">
            {student.cursos_matriculados!.map((curso) => (
              <div key={curso.id_curso} className="rounded-lg bg-muted px-3 py-1.5">
                <p className="font-medium text-foreground">{curso.nome_curso}</p>
                <p className="text-muted-foreground">
                  Matrícula: {fmtDate(curso.data_matricula)}
                  {curso.tag ? ` · ${curso.tag}` : ""}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Progresso de uso */}
      {prog && (
        <div>
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Progresso
            </span>
            <span className="text-foreground">{Math.round(prog.percentual_geral)}%</span>
          </div>
          <Bar pct={prog.percentual_geral} />
          <div className="mt-2 space-y-1.5">
            {(prog.por_curso ?? []).map((pc) => (
              <div key={pc.id_curso} className="rounded-lg bg-muted px-3 py-1.5">
                <div className="flex items-center justify-between">
                  <span className="truncate text-foreground">{pc.nome_curso}</span>
                  <span className="text-muted-foreground">
                    {pc.aulas_concluidas}/{pc.total_aulas}
                  </span>
                </div>
                <div className="mt-1">
                  <Bar pct={pc.percentual_concluidas} />
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  Vídeo assistido: {Math.round(pc.media_video_assistido)}%
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Redações */}
      {student.redacoes && (
        <p className="px-1 text-muted-foreground">
          Redações: <span className="text-foreground">{student.redacoes.total}</span>
        </p>
      )}
    </div>
  );
}
