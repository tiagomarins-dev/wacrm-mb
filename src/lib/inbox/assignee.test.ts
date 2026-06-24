import { describe, expect, it } from "vitest";
import { resolveAssignee } from "./assignee";
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";
import type { Profile, AiProfilePublic } from "@/types";

const PROFILES: Profile[] = [
  { id: "p", user_id: "u1", full_name: "Maria", email: "m@x.com", role: "" } as Profile,
];
const AI: AiProfilePublic[] = [{ id: "ai-1", nome: "Vendedora", enabled: true }];

describe("resolveAssignee", () => {
  it("null/undefined → unassigned", () => {
    expect(resolveAssignee(null, PROFILES, AI)).toEqual({ kind: "unassigned" });
    expect(resolveAssignee(undefined, PROFILES, AI)).toEqual({ kind: "unassigned" });
  });

  it("AI_AGENT_USER_ID → ai-bot", () => {
    expect(resolveAssignee(AI_AGENT_USER_ID, PROFILES, AI)).toEqual({ kind: "ai-bot" });
  });

  it("id em aiProfiles → ai-profile(nome)", () => {
    expect(resolveAssignee("ai-1", PROFILES, AI)).toEqual({ kind: "ai-profile", nome: "Vendedora" });
  });

  it("user_id em profiles → human(name)", () => {
    expect(resolveAssignee("u1", PROFILES, AI)).toEqual({ kind: "human", name: "Maria" });
  });

  it("id desconhecido → unknown", () => {
    expect(resolveAssignee("xyz", PROFILES, AI)).toEqual({ kind: "unknown" });
  });

  it("precedência: AI_AGENT_USER_ID vence mesmo se também em aiProfiles", () => {
    const aiWithBot: AiProfilePublic[] = [{ id: AI_AGENT_USER_ID, nome: "X", enabled: true }];
    expect(resolveAssignee(AI_AGENT_USER_ID, PROFILES, aiWithBot)).toEqual({ kind: "ai-bot" });
  });

  it("maps vazios → não quebra", () => {
    expect(resolveAssignee("u1", [], [])).toEqual({ kind: "unknown" });
    expect(resolveAssignee(null, [], [])).toEqual({ kind: "unassigned" });
  });

  it("human com full_name vazio → {kind:'human', name:''}", () => {
    const empty: Profile[] = [{ id: "p", user_id: "u2", full_name: "", email: "", role: "" } as Profile];
    expect(resolveAssignee("u2", empty, AI)).toEqual({ kind: "human", name: "" });
  });
});
