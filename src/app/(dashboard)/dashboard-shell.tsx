"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { ActiveConnectionProvider } from "@/hooks/use-active-connection";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { cn } from "@/lib/utils";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  // O inbox gerencia a própria altura/scroll (3 painéis full-height com
  // composer fixo). Para ele, o main não rola nem tem padding — sem isso,
  // a área de mensagens e o composer brigam com o scroll/padding do main.
  const isInbox = pathname?.startsWith("/inbox") ?? false;

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    if (!loading && !user) {
      router.push("/login");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return null;

  return (
    // h-[100dvh] (não h-screen/100vh) acompanha a barra dinâmica do browser
    // mobile — sem isso o conteúdo fica atrás da chrome e o rodapé é cortado.
    <div className="flex h-[100dvh] overflow-hidden bg-background">
      <Sidebar open={sidebarOpen} onClose={closeSidebar} />
      {/* min-w-0 deixa a coluna encolher abaixo da largura do conteúdo —
          sem isso, um filho com truncate/nowrap força overflow horizontal. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header onOpenSidebar={() => setSidebarOpen(true)} />
        {/* Inbox: sem padding e sem scroll (ele gerencia internamente).
            Demais páginas: padding + scroll vertical + guard anti-overflow. */}
        <main
          className={cn(
            "min-w-0 flex-1",
            isInbox
              ? "overflow-hidden"
              : "overflow-x-hidden overflow-y-auto p-4 sm:p-6",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ActiveConnectionProvider>
        <DashboardShellInner>{children}</DashboardShellInner>
      </ActiveConnectionProvider>
    </AuthProvider>
  );
}
