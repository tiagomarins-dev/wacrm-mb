"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { deliveryAlert } from "@/lib/inbox/queue";
import { describeDeliveryError } from "@/lib/inbox/delivery-error";
import type { Conversation, Message } from "@/types";

// Faixa fixa no topo da conversa quando o contato não está recebendo o que
// mandamos (regra em queue.ts, dado do trigger 088). Fica num componente à
// parte por causa do relógio: o alerta depende do tempo, e um relógio dentro
// da thread re-renderizaria todas as mensagens a cada minuto.
// `lastOutbound` é a última mensagem nossa (conversation.last_outbound_message_id)
// quando ela está carregada na thread: dela sai o motivo da falha (092).
export function DeliveryAlertBanner({
  conversation,
  lastOutbound,
}: {
  conversation: Conversation;
  lastOutbound?: Message | null;
}) {
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

  // Motivo só quando a mensagem está de fato em 'failed': um recibo fora de
  // ordem pode deixar error_message numa mensagem que voltou a 'sent'.
  const motivo =
    alert === "failed" && lastOutbound?.status === "failed" && lastOutbound.error_message
      ? describeDeliveryError(t, lastOutbound)
      : null;

  return (
    <div
      role="alert"
      className="flex shrink-0 items-start gap-2 border-b border-red-300 bg-red-100 px-3 py-2 text-sm text-red-950 sm:px-4 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-100"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        {alert === "failed"
          ? motivo
            ? t("deliveryBannerFailedReason", { reason: motivo })
            : t("deliveryBannerFailed")
          : t("deliveryBannerUndelivered", { when })}
      </p>
    </div>
  );
}

