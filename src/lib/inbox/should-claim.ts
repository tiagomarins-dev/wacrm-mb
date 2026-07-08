// ============================================================
// Decide se o atendente que respondeu deve reivindicar a conversa: quando ela
// NÃO tem dono humano — sem responsável (null) ou com a IA (bot genérico ou um
// perfil de IA). Nunca rouba de outro humano. Pura — o route faz o I/O (lookup
// de ai_profiles) e passa `matchedAiProfile`. Espelha o estilo de assignee.ts.
// ============================================================
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";

// currentAgentId = assigned_agent_id atual da conversa; matchedAiProfile = o id
// atual casa com um perfil de IA da conta (resolvido no route via ai_profiles).
export function shouldClaimConversation(
  currentAgentId: string | null | undefined,
  matchedAiProfile: boolean,
): boolean {
  if (!currentAgentId) return true; // Fila (sem dono)
  if (currentAgentId === AI_AGENT_USER_ID) return true; // bot genérico
  return matchedAiProfile; // perfil de IA → reivindica; outro humano → não
}
