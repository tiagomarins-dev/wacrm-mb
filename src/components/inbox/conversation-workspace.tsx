"use client";

import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import type { useConversationWorkspace } from "@/hooks/use-conversation-workspace";

// ============================================================
// Painel da conversa (centro=thread + direita=contato + overlay mobile + modais
// destacados), compartilhado por /inbox e /conversations. Recebe o retorno do
// useConversationWorkspace. Layout idêntico ao inbox/page.tsx:672-793 — a LISTA
// (esquerda) fica na página; aqui vem só o "lado direito" do split.
// ============================================================
export function ConversationWorkspace({
  ws,
  showDesktopBack = false,
}: {
  ws: ReturnType<typeof useConversationWorkspace>;
  /** Mostra o "voltar" no desktop (split-view /conversations fecha a conversa). */
  showDesktopBack?: boolean;
}) {
  const { hasActiveConv, expanded, setExpanded, contactPanelOpen, contactMobileOpen, setContactMobileOpen, activeContact } = ws;

  // Render único do thread — usado na coluna OU no modal destacado (mesmas props).
  const renderThread = () => (
    <MessageThread {...ws.threadProps} backAlwaysVisible={showDesktopBack} />
  );

  return (
    <>
      {/* Escurece o fundo quando um painel está destacado (desktop). */}
      {expanded && (
        <div
          className="fixed inset-0 z-40 hidden bg-black/60 lg:block"
          onClick={() => setExpanded(null)}
          aria-hidden
        />
      )}

      {/* Center panel: Message thread. `min-w-0` é load-bearing (#165). */}
      <div
        role={expanded === "thread" ? "dialog" : undefined}
        aria-modal={expanded === "thread" || undefined}
        aria-label={expanded === "thread" ? "Conversa" : undefined}
        className={cn(
          "flex h-full min-w-0 flex-1 lg:flex",
          hasActiveConv ? "flex" : "hidden lg:flex",
          expanded === "thread" &&
            "fixed inset-2 z-50 h-auto flex-none overflow-hidden rounded-xl border border-border bg-card shadow-2xl lg:inset-x-[4vw] lg:inset-y-[4vh]",
        )}
      >
        {/* SEMPRE renderiza (nunca null) — trocar de lugar remontaria o thread. */}
        {renderThread()}
      </div>

      {/* Right panel: Contact sidebar — desktop only, quando não colapsado (#258). */}
      {contactPanelOpen && (
        <div
          role={expanded === "contact" ? "dialog" : undefined}
          aria-modal={expanded === "contact" || undefined}
          aria-label={expanded === "contact" ? "Detalhes do contato" : undefined}
          className={cn(
            "hidden h-full min-h-0 lg:block",
            expanded === "contact" &&
              "fixed inset-2 z-50 h-auto overflow-hidden rounded-xl border border-border bg-card shadow-2xl lg:inset-x-[18vw] lg:inset-y-[4vh]",
          )}
        >
          <ContactSidebar
            {...ws.sidebarProps}
            widthClassName={expanded === "contact" ? "w-full" : "w-70"}
            expanded={expanded === "contact"}
            onToggleExpand={() => setExpanded((e) => (e === "contact" ? null : "contact"))}
          />
        </div>
      )}

      {/* Overlay full-screen SÓ no mobile (lg:hidden): 3ª "tela" do contato. */}
      {contactMobileOpen && activeContact && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Detalhes do contato"
          className="fixed inset-0 z-50 flex flex-col bg-background lg:hidden"
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-3">
            <button
              type="button"
              onClick={() => setContactMobileOpen(false)}
              aria-label="Voltar"
              className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <span className="text-sm font-semibold">Detalhes do contato</span>
          </div>
          <div className="min-h-0 flex-1">
            <ContactSidebar {...ws.sidebarProps} widthClassName="w-full" />
          </div>
        </div>
      )}
    </>
  );
}
