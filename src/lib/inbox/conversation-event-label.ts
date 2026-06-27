// ============================================================
// Rótulo (interno) de um evento de transferência de conversa (mig 048).
// Função PURA — recebe `t` por injeção (sem React/i18n import), testável.
// Resolve from/to via resolveAssignee e escolhe a frase por (type, from, actor, to).
// ============================================================
import { resolveAssignee, type Assignee } from "@/lib/inbox/assignee";
import type { ConversationEvent, Profile, AiProfilePublic } from "@/types";

type T = (key: string, opts?: Record<string, unknown>) => string;

// Nome exibível de um responsável resolvido (humano/perfil IA/bot/desconhecido).
function agentName(a: Assignee, t: T): string {
  switch (a.kind) {
    case "human":
      return a.name || t("unknownAgent");
    case "ai-profile":
      return a.nome;
    case "ai-bot":
      return t("aiBotName");
    default:
      return t("unknownAgent");
  }
}

// Monta o rótulo do pill interno conforme o evento.
export function conversationEventLabel(
  ev: ConversationEvent,
  profiles: Profile[],
  aiProfiles: AiProfilePublic[],
  t: T,
): string {
  const to = resolveAssignee(ev.to_agent_id, profiles, aiProfiles);
  const from = resolveAssignee(ev.from_agent_id, profiles, aiProfiles);

  // Desatribuição (cron por inatividade ou manual): sempre "por inatividade".
  if (ev.type === "unassigned") return t("evtUnassignedIdle");
  // Encaminhamento da IA → humano (from é bot/perfil de IA; actor = sistema).
  if (from.kind === "ai-bot" || from.kind === "ai-profile") {
    return t("evtAiHandoff", { to: agentName(to, t) });
  }
  // Quem fez = o novo responsável → "assumiu".
  if (ev.actor_user_id && ev.actor_user_id === ev.to_agent_id) {
    return t("evtAssumed", { actor: agentName(to, t) });
  }
  // Humano transferiu para outro (ator ≠ destino).
  if (ev.actor_user_id) {
    return t("evtTransferred", { actor: t("someone"), to: agentName(to, t) });
  }
  // Sem ator humano (automação/fluxo atribuiu).
  return t("evtAssigned", { to: agentName(to, t) });
}
