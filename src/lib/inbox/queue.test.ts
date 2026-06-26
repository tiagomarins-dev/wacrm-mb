import { describe, expect, it } from "vitest";
import { classifyTab, sortByTab, countByTab } from "./queue";
import { AI_AGENT_USER_ID } from "@/lib/ai-agent/constants";
import type { Conversation } from "@/types";

const NOW = Date.parse("2026-06-24T12:00:00Z");
// Timestamp ISO de `min` minutos atrás (relativo a NOW).
const at = (min: number) => new Date(NOW - min * 60_000).toISOString();

// Fixture mínima de conversa (só os campos que o helper lê).
function conv(over: Partial<Conversation>): Conversation {
  return {
    id: "c", assigned_agent_id: undefined,
    last_message_sender_type: "customer", last_message_at: at(31),
    ...over,
  } as unknown as Conversation;
}

const USER = "user-1";

describe("classifyTab", () => {
  it("fila = só sem atendente (IS NULL); humano ou bot não entram", () => {
    expect(classifyTab(conv({ assigned_agent_id: undefined }), "fila", USER, NOW)).toBe(true);
    expect(classifyTab(conv({ assigned_agent_id: USER }), "fila", USER, NOW)).toBe(false);
    expect(classifyTab(conv({ assigned_agent_id: AI_AGENT_USER_ID }), "fila", USER, NOW)).toBe(false);
  });

  it("minhas = atribuída ao userId; outro user e userId vazio não entram", () => {
    expect(classifyTab(conv({ assigned_agent_id: USER }), "minhas", USER, NOW)).toBe(true);
    expect(classifyTab(conv({ assigned_agent_id: "outro" }), "minhas", USER, NOW)).toBe(false);
    expect(classifyTab(conv({ assigned_agent_id: USER }), "minhas", null, NOW)).toBe(false);
    expect(classifyTab(conv({ assigned_agent_id: USER }), "minhas", undefined, NOW)).toBe(false);
  });

  describe("sla — bordas", () => {
    const human = (over: Partial<Conversation>) =>
      conv({ assigned_agent_id: USER, last_message_sender_type: "customer", ...over });

    it("exatamente 30min NÃO entra (> estrito); 30min01s entra; 29min59s não", () => {
      expect(classifyTab(human({ last_message_at: at(30) }), "sla", USER, NOW)).toBe(false);
      expect(classifyTab(conv({ assigned_agent_id: USER, last_message_at: new Date(NOW - (30 * 60_000 + 1000)).toISOString() }), "sla", USER, NOW)).toBe(true);
      expect(classifyTab(human({ last_message_at: new Date(NOW - (29 * 60_000 + 59_000)).toISOString() }), "sla", USER, NOW)).toBe(false);
    });

    it("última msg agent/bot → exclui", () => {
      expect(classifyTab(human({ last_message_sender_type: "agent" }), "sla", USER, NOW)).toBe(false);
      expect(classifyTab(human({ last_message_sender_type: "bot" }), "sla", USER, NOW)).toBe(false);
    });

    it("atribuída ao bot → exclui; não atribuída → exclui; last_message_at null → exclui", () => {
      expect(classifyTab(conv({ assigned_agent_id: AI_AGENT_USER_ID, last_message_at: at(31) }), "sla", USER, NOW)).toBe(false);
      expect(classifyTab(conv({ assigned_agent_id: undefined, last_message_at: at(31) }), "sla", USER, NOW)).toBe(false);
      expect(classifyTab(human({ last_message_at: undefined }), "sla", USER, NOW)).toBe(false);
    });
  });

  it("geral = sempre true", () => {
    expect(classifyTab(conv({ assigned_agent_id: undefined }), "geral", USER, NOW)).toBe(true);
    expect(classifyTab(conv({ assigned_agent_id: AI_AGENT_USER_ID }), "geral", null, NOW)).toBe(true);
  });

  describe("ia — atribuída à IA (bot genérico + perfis)", () => {
    // Set montado pela page: bot genérico + ids de perfis de IA da conta.
    const AI_IDS = new Set([AI_AGENT_USER_ID, "perfil-ia-1"]);

    it("bot genérico entra", () => {
      expect(classifyTab(conv({ assigned_agent_id: AI_AGENT_USER_ID }), "ia", USER, NOW, AI_IDS)).toBe(true);
    });
    it("perfil de IA (id no set) entra", () => {
      expect(classifyTab(conv({ assigned_agent_id: "perfil-ia-1" }), "ia", USER, NOW, AI_IDS)).toBe(true);
    });
    it("humano não entra; null não entra; id fora do set não entra", () => {
      expect(classifyTab(conv({ assigned_agent_id: USER }), "ia", USER, NOW, AI_IDS)).toBe(false);
      expect(classifyTab(conv({ assigned_agent_id: undefined }), "ia", USER, NOW, AI_IDS)).toBe(false);
      expect(classifyTab(conv({ assigned_agent_id: "perfil-desconhecido" }), "ia", USER, NOW, AI_IDS)).toBe(false);
    });
    // Backward-compat: sem o 5º arg (set default vazio) → nada classifica como IA.
    it("sem aiAgentIds (4 args) → false", () => {
      expect(classifyTab(conv({ assigned_agent_id: AI_AGENT_USER_ID }), "ia", USER, NOW)).toBe(false);
    });
  });
});

describe("sortByTab", () => {
  const a = conv({ id: "a", last_message_at: at(10) }); // mais recente
  const b = conv({ id: "b", last_message_at: at(40) }); // mais antigo
  const n = conv({ id: "n", last_message_at: undefined }); // sem msg

  it("fila/sla ASC (mais antigo primeiro), NULL afunda", () => {
    expect(sortByTab([a, b, n], "fila").map((c) => c.id)).toEqual(["b", "a", "n"]);
    expect(sortByTab([a, n, b], "sla").map((c) => c.id)).toEqual(["b", "a", "n"]);
  });

  it("minhas/geral DESC (mais recente primeiro), NULL afunda", () => {
    expect(sortByTab([b, a, n], "geral").map((c) => c.id)).toEqual(["a", "b", "n"]);
    expect(sortByTab([n, b, a], "minhas").map((c) => c.id)).toEqual(["a", "b", "n"]);
  });
});

describe("countByTab", () => {
  it("conta cada aba; geral == length", () => {
    const list: Conversation[] = [
      conv({ assigned_agent_id: undefined }),                                  // fila
      conv({ assigned_agent_id: USER, last_message_sender_type: "customer", last_message_at: at(31) }), // minhas + sla
      conv({ assigned_agent_id: "outro", last_message_sender_type: "agent" }), // nem fila, nem minhas, nem sla
      conv({ assigned_agent_id: AI_AGENT_USER_ID }),                           // bot: nenhuma das humanas
    ];
    const c = countByTab(list, USER, NOW);
    expect(c.fila).toBe(1);
    expect(c.minhas).toBe(1);
    expect(c.sla).toBe(1);
    expect(c.ia).toBe(0); // sem aiAgentIds → nenhuma conversa classifica como IA
    expect(c.geral).toBe(list.length);
  });

  it("conta ia quando recebe o set", () => {
    const ai = new Set([AI_AGENT_USER_ID, "perfil-ia-1"]);
    const list: Conversation[] = [
      conv({ assigned_agent_id: AI_AGENT_USER_ID }),
      conv({ assigned_agent_id: "perfil-ia-1" }),
      conv({ assigned_agent_id: USER }),
    ];
    expect(countByTab(list, USER, NOW, ai).ia).toBe(2);
  });
});

// Efeito da desatribuição automática (cron 045): atribuída NÃO está em Fila;
// ao virar assigned_agent_id=null (pós-unassign) ENTRA em Fila.
describe("desatribuição → volta pra fila", () => {
  it("atribuída fora da fila; null entra na fila", () => {
    const atribuida = conv({ assigned_agent_id: "atendente-x" });
    expect(classifyTab(atribuida, "fila", USER, NOW)).toBe(false);
    const liberada = conv({ assigned_agent_id: undefined });
    expect(classifyTab(liberada, "fila", USER, NOW)).toBe(true);
  });
});
