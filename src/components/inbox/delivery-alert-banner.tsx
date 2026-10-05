"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { deliveryAlert } from "@/lib/inbox/queue";
import type { Conversation } from "@/types";

// Faixa fixa no topo da conversa quando o contato não está recebendo o que
// mandamos (regra em queue.ts, dado do trigger 088). Fica num componente à
// parte por causa do relógio: o alerta depende do tempo, e um relógio dentro
// da thread re-renderizaria todas as mensagens a cada minuto.
export function DeliveryAlertBanner({ conversation }: { conversation: Conversation }) {
  const { t, i18n } = useTranslation("inbox");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const alert = deliveryAlert(conversation, now);
  if (!alert) return null;

  // "há 3 horas" / "3 hours ago" — mesmo locale da lista de conversas.
  const when = conversation.last_outbound_at
    ? formatDistanceToNow(new Date(conversation.last_outbound_at), {
        addSuffix: true,
        locale: i18n.language === "pt-BR" ? ptBR : undefined,
      })
    : "";

  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-red-300 bg-red-100 px-3 py-2 text-sm text-red-950 sm:px-4 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-100"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        {alert === "failed"
          ? t("deliveryBannerFailed")
          : t("deliveryBannerUndelivered", { when })}
      </p>
    </div>
  );
}
