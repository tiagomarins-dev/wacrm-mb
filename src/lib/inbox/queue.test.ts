import { describe, expect, it } from "vitest";
import { classifyTab, sortByTab, countByTab, effectiveDir, pinFavoritesFirst } from "./queue";
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
    // Finalizada sai da aba, igual às demais abas de trabalho. É o que permite a
    // query da lista filtrar status != closed sem esconder a lente de IA.
    it("finalizada não entra, mesmo atribuída à IA", () => {
      expect(classifyTab(conv({ assigned_agent_id: AI_AGENT_USER_ID, status: "closed" }), "ia", USER, NOW, AI_IDS)).toBe(false);
      expect(classifyTab(conv({ assigned_agent_id: "perfil-ia-1", status: "closed" }), "ia", USER, NOW, AI_IDS)).toBe(false);
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

  it("override dir vence o default da aba", () => {
    // minhas é DESC por default; forçar asc inverte (mais antigo primeiro).
    expect(sortByTab([a, b, n], "minhas", "asc").map((c) => c.id)).toEqual(["b", "a", "n"]);
    // fila é ASC por default; forçar desc inverte (mais recente primeiro).
    expect(sortByTab([a, b, n], "fila", "desc").map((c) => c.id)).toEqual(["a", "b", "n"]);
  });

  it("dir undefined ≡ sem dir (default por aba)", () => {
    expect(sortByTab([a, b, n], "minhas", undefined).map((c) => c.id)).toEqual(["a", "b", "n"]);
    expect(sortByTab([a, b, n], "fila", undefined).map((c) => c.id)).toEqual(["b", "a", "n"]);
  });

  it("NULL afunda nos dois sentidos", () => {
    expect(sortByTab([a, n, b], "minhas", "asc").map((c) => c.id)).toEqual(["b", "a", "n"]);
    expect(sortByTab([a, n, b], "minhas", "desc").map((c) => c.id)).toEqual(["a", "b", "n"]);
  });
});

describe("effectiveDir", () => {
  it("sem override → default da aba", () => {
    expect(effectiveDir("fila", null)).toBe("asc");
    expect(effectiveDir("sla", null)).toBe("asc");
    expect(effectiveDir("minhas", null)).toBe("desc");
    expect(effectiveDir("ia", null)).toBe("desc");
    expect(effectiveDir("geral", null)).toBe("desc");
  });
  it("override vence o default", () => {
    expect(effectiveDir("fila", "desc")).toBe("desc");
    expect(effectiveDir("minhas", "asc")).toBe("asc");
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

// Status "Finalizada" (closed) sai das abas de trabalho (fila/minhas/sla/ia),
// mas permanece em geral. Aberta mantém o comportamento atual (regressão).
describe("closed — sai das abas de trabalho, mantém geral", () => {
  it("closed + sem dono → fora da fila; open → dentro (regressão)", () => {
    expect(classifyTab(conv({ assigned_agent_id: undefined, status: "closed" }), "fila", USER, NOW)).toBe(false);
    expect(classifyTab(conv({ assigned_agent_id: undefined, status: "open" }), "fila", USER, NOW)).toBe(true);
  });
  it("closed + minha → fora de minhas; open → dentro", () => {
    expect(classifyTab(conv({ assigned_agent_id: USER, status: "closed" }), "minhas", USER, NOW)).toBe(false);
    expect(classifyTab(conv({ assigned_agent_id: USER, status: "open" }), "minhas", USER, NOW)).toBe(true);
  });
  it("closed + humano + idle>30min → fora de SLA; open → dentro", () => {
    const base = { assigned_agent_id: "h1", last_message_sender_type: "customer" as const, last_message_at: at(31) };
    expect(classifyTab(conv({ ...base, status: "closed" }), "sla", USER, NOW)).toBe(false);
    expect(classifyTab(conv({ ...base, status: "open" }), "sla", USER, NOW)).toBe(true);
  });
  it("closed permanece em geral", () => {
    expect(classifyTab(conv({ status: "closed" }), "geral", USER, NOW)).toBe(true);
  });
  it("countByTab: closed+sem dono não conta fila mas conta geral", () => {
    const c = countByTab([conv({ assigned_agent_id: undefined, status: "closed" })], USER, NOW);
    expect(c.fila).toBe(0);
    expect(c.geral).toBe(1);
  });
});

// Favorito (076): pina na aba "minhas" mesmo desatribuída/de outro/fechada.
describe("classifyTab — favoritos (076)", () => {
  const FAV = new Set(["c"]);
  const NO_AI = new Set<string>();

  it("favoritada entra na minhas: desatribuída, de outro user e fechada", () => {
    expect(classifyTab(conv({ assigned_agent_id: undefined }), "minhas", USER, NOW, NO_AI, FAV)).toBe(true);
    expect(classifyTab(conv({ assigned_agent_id: "outro" }), "minhas", USER, NOW, NO_AI, FAV)).toBe(true);
    expect(classifyTab(conv({ assigned_agent_id: undefined, status: "closed" }), "minhas", USER, NOW, NO_AI, FAV)).toBe(true);
  });

  it("favoritada + atribuída a mim continua entrando (mesma linha, sem duplicar)", () => {
    expect(classifyTab(conv({ assigned_agent_id: USER }), "minhas", USER, NOW, NO_AI, FAV)).toBe(true);
  });

  it("não-favoritada fechada + minha NÃO entra (regra atual preservada)", () => {
    expect(classifyTab(conv({ assigned_agent_id: USER, status: "closed" }), "minhas", USER, NOW)).toBe(false);
  });

  it("userId null → false mesmo favoritada", () => {
    expect(classifyTab(conv({}), "minhas", null, NOW, NO_AI, FAV)).toBe(false);
  });

  it("fechada favoritada NÃO entra na fila nem no sla", () => {
    const closedFav = conv({ assigned_agent_id: undefined, status: "closed" });
    expect(classifyTab(closedFav, "fila", USER, NOW, NO_AI, FAV)).toBe(false);
    expect(classifyTab(closedFav, "sla", USER, NOW, NO_AI, FAV)).toBe(false);
  });

  it("countByTab conta favoritada desatribuída/fechada na minhas", () => {
    const list = [
      conv({ id: "c", assigned_agent_id: undefined, status: "closed" }),
      conv({ id: "outra", assigned_agent_id: USER }),
    ];
    const counts = countByTab(list, USER, NOW, NO_AI, FAV);
    expect(counts.minhas).toBe(2);
    expect(counts.fila).toBe(0);
  });
});

describe("pinFavoritesFirst", () => {
  const mk = (id: string) => conv({ id });

  it("favoritas sobem preservando a ordem relativa dos dois grupos", () => {
    const list = [mk("a"), mk("b"), mk("c"), mk("d")];
    const out = pinFavoritesFirst(list, new Set(["b", "d"]));
    expect(out.map((c) => c.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("Set vazio devolve a lista idêntica (mesma referência)", () => {
    const list = [mk("a"), mk("b")];
    expect(pinFavoritesFirst(list, new Set())).toBe(list);
  });

  it("id favoritado ausente da lista é no-op", () => {
    const list = [mk("a")];
    expect(pinFavoritesFirst(list, new Set(["zzz"])).map((c) => c.id)).toEqual(["a"]);
  });
});
