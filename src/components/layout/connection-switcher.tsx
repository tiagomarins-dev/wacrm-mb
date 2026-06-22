"use client";

// Seletor de CONEXÃO ATIVA no header (multi-número, 033). Só aparece
// quando a conta tem 2+ conexões — com uma só, não há o que trocar.
// Trocar grava o cookie (via hook) e dá router.refresh() para rebuscar
// os dados server-rendered da nova conexão.

import { useRouter } from "next/navigation";
import { Check, Smartphone } from "lucide-react";
import { useActiveConnection } from "@/hooks/use-active-connection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ConnectionSwitcher() {
  const router = useRouter();
  const { connections, activeConnection, setActiveConnection } =
    useActiveConnection();

  // Com 0 ou 1 conexão não há troca a fazer.
  if (connections.length <= 1) return null;

  const label = activeConnection?.phone_number_id ?? "Conexão";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70"
        aria-label="Trocar conexão WhatsApp ativa"
      >
        <Smartphone className="size-4" />
        <span className="hidden max-w-[120px] truncate sm:inline">{label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-56 bg-popover text-popover-foreground ring-border"
      >
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          Conexão WhatsApp ativa
        </div>
        {connections.map((c) => (
          <DropdownMenuItem
            key={c.id}
            onClick={() => {
              setActiveConnection(c.id);
              router.refresh();
            }}
            className="justify-between text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <span className="flex items-center gap-2 truncate">
              <Smartphone className="size-4 shrink-0" />
              <span className="truncate">
                {c.phone_number_id}
                {c.is_primary ? " · primária" : ""}
                {c.status === "disconnected" ? " · desconectada" : ""}
              </span>
            </span>
            {c.id === activeConnection?.id ? (
              <Check className="size-4 shrink-0" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
