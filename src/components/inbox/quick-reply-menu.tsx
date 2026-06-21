"use client";

import { cn } from "@/lib/utils";
import type { QuickReply } from "@/types";

interface QuickReplyMenuProps {
  items: QuickReply[];
  activeIndex: number;
  onSelect: (r: QuickReply) => void;
  onHover: (index: number) => void;
}

/**
 * Painel de respostas rápidas que abre ACIMA do composer quando o agente
 * digita "/". Apresentacional: a navegação por teclado e o índice ativo
 * são controlados pelo composer (pai). Renderiza textos como texto puro
 * (sem dangerouslySetInnerHTML). Não renderiza nada se a lista vier vazia.
 */
export function QuickReplyMenu({
  items,
  activeIndex,
  onSelect,
  onHover,
}: QuickReplyMenuProps) {
  if (items.length === 0) return null;

  return (
    <div className="absolute bottom-full left-3 right-3 z-20 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
      <p className="border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Quick replies
      </p>
      <ul className="max-h-60 overflow-y-auto py-1">
        {items.map((r, i) => (
          <li key={r.id}>
            <button
              type="button"
              // onMouseDown (não onClick): dispara antes do textarea perder o
              // foco/blur, garantindo a inserção no ponto certo do cursor.
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(r);
              }}
              onMouseEnter={() => onHover(i)}
              className={cn(
                "flex w-full items-start gap-2 px-3 py-2 text-left",
                i === activeIndex ? "bg-muted" : "hover:bg-muted/60",
              )}
            >
              <code className="mt-0.5 shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
                /{r.shortcut}
              </code>
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                {r.message_text}
              </span>
              {r.scope === "account" && (
                <span className="mt-0.5 shrink-0 rounded-full border border-border px-1.5 text-[9px] uppercase text-muted-foreground">
                  team
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
