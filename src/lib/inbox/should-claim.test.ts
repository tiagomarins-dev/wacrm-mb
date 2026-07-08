import { describe, expect, it } from "vitest";
import { shouldClaimConversation } from "./should-claim";
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";

describe("shouldClaimConversation", () => {
  it("sem dono (null/undefined) → reivindica", () => {
    expect(shouldClaimConversation(null, false)).toBe(true);
    expect(shouldClaimConversation(undefined, false)).toBe(true);
  });

  it("bot genérico (AI_AGENT_USER_ID) → reivindica", () => {
    expect(shouldClaimConversation(AI_AGENT_USER_ID, false)).toBe(true);
  });

  it("perfil de IA da conta (matchedAiProfile) → reivindica", () => {
    expect(shouldClaimConversation("perfil-ia-1", true)).toBe(true);
  });

  it("outro humano → NÃO reivindica (guard anti-roubo)", () => {
    expect(shouldClaimConversation("humano-123", false)).toBe(false);
  });

  it("id não-nulo sem casar perfil (ex.: perfil de outra conta) → NÃO reivindica", () => {
    // O route só passa matchedAiProfile=true quando o lookup casa na conta certa;
    // perfil de outra conta → matchedAiProfile=false → trata como humano.
    expect(shouldClaimConversation("perfil-de-outra-conta", false)).toBe(false);
  });
});
