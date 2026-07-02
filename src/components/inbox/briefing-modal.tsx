"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Copy } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { BRIEFING_MESSAGE_LIMIT } from "@/lib/integrations/openrouter";

interface BriefingModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}

// Renderiza os trechos **negrito** de uma linha como <strong>; o resto vira texto.
// Subset de markdown: o briefing só usa **negrito** inline (sem links/itálico).
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={`${keyPrefix}-${i}`} className="font-semibold text-foreground">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>;
  });
}

/**
 * Renderer leve do markdown que a IA devolve no briefing (evita dep de
 * react-markdown p/ um subset conhecido): headers (linha toda em **negrito**),
 * bullets (-, *, •) agrupados em lista, negrito inline e parágrafos.
 */
function FormattedBriefing({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  // Fecha a lista pendente de bullets em um <ul> antes de emitir outro bloco.
  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul
        key={`ul-${blocks.length}`}
        className="my-1 list-disc space-y-1 pl-5 text-muted-foreground"
      >
        {items.map((it, i) => (
          <li key={i}>{renderInline(it, `li-${blocks.length}-${i}`)}</li>
        ))}
      </ul>,
    );
  };

  text.split("\n").forEach((raw) => {
    const line = raw.trim();
    if (!line) {
      flushBullets();
      return;
    }
    // Bullet: começa com -, * ou • seguido de espaço (o ** de header não casa).
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]);
      return;
    }
    flushBullets();
    // Header: linha inteira em negrito (ex.: "**1) Resumo em 1 linha**").
    const isHeading = /^\*\*.+\*\*$/.test(line);
    blocks.push(
      <p
        key={`p-${blocks.length}`}
        className={
          isHeading
            ? "mt-3 font-semibold text-foreground first:mt-0"
            : "text-muted-foreground"
        }
      >
        {renderInline(line, `p-${blocks.length}`)}
      </p>,
    );
  });
  flushBullets();

  return <div className="space-y-1 text-sm leading-relaxed">{blocks}</div>;
}

/**
 * Modal de briefing da conversa: ao abrir, gera com IA um resumo estruturado
 * (tratado/prometido/pendências/próximos passos) p/ o novo atendente. On-demand
 * — não persiste. Espelha o padrão de fetch/estado do share-modal.tsx.
 */
export function BriefingModal({
  open,
  onOpenChange,
  conversationId,
}: BriefingModalProps) {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");

  // Gera o briefing (chamado ao abrir e no "Regenerar").
  const generate = useCallback(async () => {
    setLoading(true);
    setError("");
    setSummary("");
    try {
      const res = await fetch("/api/integrations/briefing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Falha ao gerar o briefing");
      setSummary(data.summary ?? "");
      setTruncated(Boolean(data.truncated));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Falha ao gerar o briefing");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  // Gera uma vez ao abrir.
  useEffect(() => {
    if (open) generate();
  }, [open, generate]);

  // Copiar com fallback: navigator.clipboard falha em HTTP puro (self-host por IP).
  const copy = useCallback(async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(summary);
      } else {
        const ta = document.createElement("textarea");
        ta.value = summary;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast.success("Briefing copiado");
    } catch {
      toast.error("Não foi possível copiar");
    }
  }, [summary]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[92vw] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" /> Briefing da conversa
          </DialogTitle>
          <DialogDescription>
            Resumo do atendimento para quem for assumir a conversa.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Gerando briefing…
          </div>
        ) : error ? (
          <p className="py-4 text-sm text-red-400">{error}</p>
        ) : (
          <>
            <div className="max-h-[65vh] overflow-y-auto rounded-md bg-muted/50 p-4">
              <FormattedBriefing text={summary} />
            </div>
            {truncated && (
              <p className="mt-1 text-xs text-muted-foreground">
                Mostrando as últimas {BRIEFING_MESSAGE_LIMIT} mensagens da conversa.
              </p>
            )}
          </>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={copy}
            disabled={loading || !summary}
          >
            <Copy className="mr-1 h-3.5 w-3.5" /> Copiar
          </Button>
          {/* Regenerar travado durante loading (endpoint pago, evita clique-duplo). */}
          <Button size="sm" onClick={generate} disabled={loading}>
            Regenerar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
