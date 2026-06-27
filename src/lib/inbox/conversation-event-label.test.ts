import { describe, expect, it } from "vitest";
import { conversationEventLabel } from "./conversation-event-label";
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";
import type { ConversationEvent, Profile, AiProfilePublic } from "@/types";

// t mock: ecoa a chave + interpola {{var}} pra dar pra asserir.
const t = (k: string, o?: Record<string, unknown>) =>
  o ? `${k}:${Object.entries(o).map(([key, v]) => `${key}=${v}`).join(",")}` : k;

const PROFILES: Profile[] = [
  { id: "p1", user_id: "u1", full_name: "Maria", email: "m@x.com", role: "" } as Profile,
  { id: "p2", user_id: "u2", full_name: "João", email: "j@x.com", role: "" } as Profile,
];
const AI: AiProfilePublic[] = [{ id: "ai-1", nome: "Ruth", enabled: true }];

// Fixture mínima de evento.
function ev(over: Partial<ConversationEvent>): ConversationEvent {
  return {
    id: "e", account_id: "a", conversation_id: "c",
    type: "transferred", from_agent_id: null, to_agent_id: null,
    actor_user_id: null, created_at: "2026-06-27T00:00:00Z",
    ...over,
  };
}

describe("conversationEventLabel", () => {
  it("unassigned (cron/ociosa) → evtUnassignedIdle", () => {
    expect(conversationEventLabel(ev({ type: "unassigned", from_agent_id: "u1", to_agent_id: null }), PROFILES, AI, t))
      .toBe("evtUnassignedIdle");
  });

  it("from = bot genérico → evtAiHandoff", () => {
    expect(conversationEventLabel(ev({ from_agent_id: AI_AGENT_USER_ID, to_agent_id: "u1", actor_user_id: null }), PROFILES, AI, t))
      .toBe("evtAiHandoff:to=Maria");
  });

  it("from = perfil de IA → evtAiHandoff", () => {
    expect(conversationEventLabel(ev({ from_agent_id: "ai-1", to_agent_id: "u2" }), PROFILES, AI, t))
      .toBe("evtAiHandoff:to=João");
  });

  it("actor == to (humano) → evtAssumed", () => {
    expect(conversationEventLabel(ev({ from_agent_id: "u2", to_agent_id: "u1", actor_user_id: "u1" }), PROFILES, AI, t))
      .toBe("evtAssumed:actor=Maria");
  });

  it("actor != to (humano transferiu) → evtTransferred", () => {
    expect(conversationEventLabel(ev({ from_agent_id: null, to_agent_id: "u2", actor_user_id: "u1" }), PROFILES, AI, t))
      .toBe("evtTransferred:actor=someone,to=João");
  });

  it("actor null + to humano (automação/fluxo) → evtAssigned", () => {
    expect(conversationEventLabel(ev({ type: "assigned", from_agent_id: null, to_agent_id: "u1", actor_user_id: null }), PROFILES, AI, t))
      .toBe("evtAssigned:to=Maria");
  });

  it("to órfão → fallback unknownAgent (não quebra)", () => {
    expect(conversationEventLabel(ev({ from_agent_id: null, to_agent_id: "xyz", actor_user_id: "u1" }), PROFILES, AI, t))
      .toBe("evtTransferred:actor=someone,to=unknownAgent");
  });

  it("maps vazios → não quebra", () => {
    // actor ≠ to → transferred; to resolve a unknownAgent (maps vazios).
    expect(conversationEventLabel(ev({ to_agent_id: "u1", actor_user_id: "u9" }), [], [], t))
      .toBe("evtTransferred:actor=someone,to=unknownAgent");
  });
});
