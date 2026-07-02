"use client";

import { useState, useEffect, useCallback } from "react";
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
      <DialogContent className="max-w-lg">
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
            <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-sm">
              {summary}
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
