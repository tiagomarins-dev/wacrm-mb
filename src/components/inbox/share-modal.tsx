"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Send, ExternalLink } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { NotionFieldMeta } from "@/lib/integrations/notion";

export type ShareProvider = "notion" | "slack";

interface ShareModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: ShareProvider | null;
  conversationId: string;
  contactName?: string;
}

interface NotionUser {
  id: string;
  name: string;
}

const LABEL: Record<ShareProvider, string> = { notion: "Notion", slack: "Slack" };
type FieldValue = string | string[];

/**
 * Modal de compartilhamento. Sempre passa por preview (revisão humana). Para
 * Notion, carrega os campos da database (Categoria/Área/Prioridade/Status/
 * Responsável/Prazo) e os usuários, montando selects dinâmicos.
 */
export function ShareModal({
  open,
  onOpenChange,
  provider,
  conversationId,
  contactName,
}: ShareModalProps) {
  const [topic, setTopic] = useState("");
  const [note, setNote] = useState("");
  const [summary, setSummary] = useState("");
  const [generating, setGenerating] = useState(false);
  const [sending, setSending] = useState(false);

  // Notion dynamic fields
  const [fields, setFields] = useState<NotionFieldMeta[]>([]);
  const [users, setUsers] = useState<NotionUser[]>([]);
  const [values, setValues] = useState<Record<string, FieldValue>>({});

  // Reset ao abrir / trocar provedor.
  useEffect(() => {
    if (!open) return;
    setTopic("");
    setNote("");
    setSummary("");
    setGenerating(false);
    setSending(false);
    setFields([]);
    setUsers([]);
    setValues({});
    if (provider === "notion") {
      (async () => {
        try {
          const res = await fetch("/api/integrations/notion/meta");
          if (!res.ok) return;
          const data = (await res.json()) as {
            fields?: NotionFieldMeta[];
            users?: NotionUser[];
          };
          setFields(data.fields ?? []);
          setUsers(data.users ?? []);
          // Default: Status = "A Fazer" se existir.
          const statusField = (data.fields ?? []).find((f) => f.type === "status");
          if (statusField?.options?.includes("A Fazer")) {
            setValues((v) => ({ ...v, [statusField.name]: "A Fazer" }));
          }
        } catch {
          /* meta é best-effort; modal funciona sem os campos */
        }
      })();
    }
  }, [open, provider]);

  if (!provider) return null;
  const label = LABEL[provider];

  function setVal(name: string, value: FieldValue) {
    setValues((v) => ({ ...v, [name]: value }));
  }

  function toggleMulti(name: string, option: string) {
    setValues((v) => {
      const cur = Array.isArray(v[name]) ? (v[name] as string[]) : [];
      return {
        ...v,
        [name]: cur.includes(option)
          ? cur.filter((o) => o !== option)
          : [...cur, option],
      };
    });
  }

  async function generate() {
    if (!topic.trim()) {
      toast.error("Informe o assunto");
      return;
    }
    setGenerating(true);
    try {
      const res = await fetch("/api/integrations/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "preview",
          provider,
          conversationId,
          topic: topic.trim(),
          note: note.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Falha ao gerar resumo");
      setSummary(data.summary ?? "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao gerar resumo");
    } finally {
      setGenerating(false);
    }
  }

  async function send() {
    if (!summary.trim()) return;
    setSending(true);
    try {
      const notionProperties =
        provider === "notion"
          ? fields
              .map((f) => ({ name: f.name, type: f.type, value: values[f.name] }))
              .filter((p) =>
                Array.isArray(p.value) ? p.value.length > 0 : Boolean(p.value),
              )
          : undefined;

      const res = await fetch("/api/integrations/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "send",
          provider,
          conversationId,
          topic: topic.trim(),
          note: note.trim(),
          summary: summary.trim(),
          notionProperties,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Falha ao enviar");
      toast.success(
        data.external_url ? (
          <span className="inline-flex items-center gap-1">
            Enviado para {label}
            <a
              href={data.external_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 underline"
            >
              abrir <ExternalLink className="size-3" />
            </a>
          </span>
        ) : (
          `Enviado para ${label}`
        ),
      );
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha ao enviar");
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Compartilhar no {label}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            A IA resume as últimas mensagens conforme o assunto
            {contactName ? ` de ${contactName}` : ""}. Revise antes de enviar; os
            dados do contato são anexados automaticamente.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Assunto
            </label>
            <Input
              value={topic}
              maxLength={200}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="ex: Bug na plataforma / dúvida de pagamento"
              className="border-border bg-background text-foreground"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              Nota (opcional)
            </label>
            <Input
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder="contexto extra p/ o resumo"
              className="border-border bg-background text-foreground"
            />
          </div>

          {!summary ? (
            <Button
              onClick={generate}
              disabled={generating || !topic.trim()}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {generating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Gerar resumo
            </Button>
          ) : (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Resumo (edite se precisar)
              </label>
              <Textarea
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={6}
                className="border-border bg-background text-foreground"
              />
              <button
                type="button"
                onClick={generate}
                disabled={generating}
                className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                {generating ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Sparkles className="size-3" />
                )}
                Gerar de novo
              </button>
            </div>
          )}

          {/* Campos do Notion (database configurada) */}
          {provider === "notion" && fields.length > 0 && (
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Campos do Notion
              </p>
              {fields.map((f) => {
                const val = values[f.name];
                if (f.type === "select" || f.type === "status") {
                  return (
                    <FieldRow key={f.name} label={f.name}>
                      <select
                        value={(val as string) ?? ""}
                        onChange={(e) => setVal(f.name, e.target.value)}
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      >
                        <option value="">—</option>
                        {f.options?.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    </FieldRow>
                  );
                }
                if (f.type === "people") {
                  return (
                    <FieldRow key={f.name} label={f.name}>
                      <select
                        value={(val as string) ?? ""}
                        onChange={(e) =>
                          setVal(f.name, e.target.value ? [e.target.value] : "")
                        }
                        className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      >
                        <option value="">—</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                    </FieldRow>
                  );
                }
                if (f.type === "date") {
                  return (
                    <FieldRow key={f.name} label={f.name}>
                      <Input
                        type="date"
                        value={(val as string) ?? ""}
                        onChange={(e) => setVal(f.name, e.target.value)}
                        className="border-border bg-background text-foreground"
                      />
                    </FieldRow>
                  );
                }
                // multi_select → chips
                const selected = Array.isArray(val) ? val : [];
                return (
                  <FieldRow key={f.name} label={f.name}>
                    <div className="flex flex-wrap gap-1.5">
                      {f.options?.map((o) => {
                        const on = selected.includes(o);
                        return (
                          <button
                            key={o}
                            type="button"
                            onClick={() => toggleMulti(f.name, o)}
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-xs transition-colors",
                              on
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border text-muted-foreground hover:bg-muted",
                            )}
                          >
                            {o}
                          </button>
                        );
                      })}
                    </div>
                  </FieldRow>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground"
          >
            Cancelar
          </Button>
          <Button
            onClick={send}
            disabled={!summary.trim() || sending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Enviar para {label}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}
