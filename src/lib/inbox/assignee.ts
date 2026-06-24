// ============================================================
// Resolve o "responsável" de uma conversa (assigned_agent_id) num discriminador
// — a tradução/render fica na page (helper puro, testável, sem i18n).
// Espelha a lógica de message-thread.tsx:863-872.
// ============================================================
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";
import type { Profile, AiProfilePublic } from "@/types";

export type Assignee =
  | { kind: "unassigned" }
  | { kind: "ai-bot" } // AI_AGENT_USER_ID (bot genérico)
  | { kind: "ai-profile"; nome: string } // perfil de IA atribuído
  | { kind: "human"; name: string } // membro humano
  | { kind: "unknown" }; // id não resolvido

// Precedência: unassigned → ai-bot → ai-profile → human → unknown.
export function resolveAssignee(
  id: string | null | undefined,
  profiles: Profile[],
  aiProfiles: AiProfilePublic[],
): Assignee {
  if (!id) return { kind: "unassigned" };
  if (id === AI_AGENT_USER_ID) return { kind: "ai-bot" };
  const ai = aiProfiles.find((p) => p.id === id);
  if (ai) return { kind: "ai-profile", nome: ai.nome };
  const human = profiles.find((p) => p.user_id === id);
  if (human) return { kind: "human", name: human.full_name };
  return { kind: "unknown" };
}
