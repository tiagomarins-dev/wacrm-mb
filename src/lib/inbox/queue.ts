// ============================================================
// Classificação/ordenação/contagem das abas do inbox (fila de atendimento).
// Funções PURAS — recebem `now` por parâmetro (nunca Date.now() interno),
// pra o SLA ser testável de forma determinística.
// ============================================================
import type { Conversation } from "@/types";
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";

export type QueueTab = "fila" | "minhas" | "sla" | "geral";

// Limite do SLA (min sem resposta do atendente). Sem número mágico solto.
export const SLA_THRESHOLD_MIN = 30;
const SLA_MS = SLA_THRESHOLD_MIN * 60_000;

// Uma conversa pertence à aba? `userId` = id do usuário logado (Minhas).
export function classifyTab(
  conv: Conversation,
  tab: QueueTab,
  userId: string | null | undefined,
  now: number,
): boolean {
  const assigned = conv.assigned_agent_id ?? null;
  switch (tab) {
    case "fila":
      // Sem atendente (nem humano nem bot).
      return assigned === null;
    case "minhas":
      return !!userId && assigned === userId;
    case "sla": {
      // Atribuída a HUMANO (não bot), última msg do cliente, parada > 30min.
      if (!assigned || assigned === AI_AGENT_USER_ID) return false;
      if (conv.last_message_sender_type !== "customer") return false;
      if (!conv.last_message_at) return false;
      return now - new Date(conv.last_message_at).getTime() > SLA_MS;
    }
    case "geral":
      return true;
  }
}

// Ordena por aba: Fila/SLA ASC (mais antigo no topo, FIFO/mais estourada);
// Minhas/Geral DESC. Conversa sem last_message_at SEMPRE afunda.
export function sortByTab(list: Conversation[], tab: QueueTab): Conversation[] {
  const asc = tab === "fila" || tab === "sla";
  return [...list].sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : null;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : null;
    if (ta === null && tb === null) return 0;
    if (ta === null) return 1; // NULL afunda
    if (tb === null) return -1;
    return asc ? ta - tb : tb - ta;
  });
}

// Contadores de cada aba (badges). Deriva da lista inteira em memória.
export function countByTab(
  list: Conversation[],
  userId: string | null | undefined,
  now: number,
): Record<QueueTab, number> {
  const acc: Record<QueueTab, number> = { fila: 0, minhas: 0, sla: 0, geral: 0 };
  for (const c of list) {
    if (classifyTab(c, "fila", userId, now)) acc.fila++;
    if (classifyTab(c, "minhas", userId, now)) acc.minhas++;
    if (classifyTab(c, "sla", userId, now)) acc.sla++;
    acc.geral++;
  }
  return acc;
}
