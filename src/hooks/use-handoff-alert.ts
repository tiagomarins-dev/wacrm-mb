"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { ConversationEvent } from "@/types";

/**
 * Avisa na tela quando uma conversa é atribuída ao usuário logado — típico da
 * IA chamando transferir_humano, mas vale para transferência feita por colega.
 *
 * Escuta INSERT em conversation_events, e não UPDATE em conversations, porque a
 * REPLICA IDENTITY das tabelas é `default`: o `old` do payload de UPDATE só traz
 * a chave primária, então não dá para saber se o responsável MUDOU nesta escrita
 * — o toast dispararia a cada mensagem nova da conversa. O INSERT sempre carrega
 * a linha inteira, e o trigger trg_log_conversation_assignment já grava um evento
 * a cada troca de assigned_agent_id.
 *
 * Canal próprio, separado do inbox e do contador de não-lidas, para os três
 * coexistirem sem disputar estado. Montado na sidebar: assim o aviso chega em
 * qualquer página do dashboard.
 */
export function useHandoffAlert(currentUserId: string | null) {
  const router = useRouter();
  const { t } = useTranslation("inbox");

  // t e router entram por ref: mudam de identidade a cada render e re-assinariam
  // o canal à toa. O callback do realtime só lê `.current`, sempre após o render.
  const tRef = useRef(t);
  const routerRef = useRef(router);
  useEffect(() => {
    tRef.current = t;
    routerRef.current = router;
  });

  useEffect(() => {
    if (!currentUserId) return;
    const supabase = createClient();

    const channel = supabase
      .channel("handoff-alert-realtime")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "conversation_events" },
        (payload) => {
          const ev = payload.new as ConversationEvent;
          // Só atribuição/transferência PARA mim. 'unassigned' e 'status_changed'
          // não têm destinatário; conversa que eu mesmo puxei não vira aviso.
          if (ev.type !== "assigned" && ev.type !== "transferred") return;
          if (ev.to_agent_id !== currentUserId) return;
          if (ev.actor_user_id === currentUserId) return;

          // Transferência da IA não tem ator (service role, sem auth.uid()).
          const daIA = !ev.actor_user_id;
          toast.info(tRef.current(daIA ? "handoffFromAi" : "handoffFromTeammate"), {
            description: tRef.current("handoffOpenHint"),
            duration: 10_000,
            action: {
              label: tRef.current("handoffOpen"),
              onClick: () => routerRef.current.push(`/inbox?c=${ev.conversation_id}`),
            },
          });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [currentUserId]);
}
