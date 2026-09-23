import { describe, expect, it } from "vitest";
import { prependOlder, toThreadPage, withinLoadedWindow, THREAD_PAGE_SIZE } from "./thread-page";
import type { Message } from "@/types";

const msg = (id: string, at: string): Message =>
  ({ id, created_at: at, conversation_id: "c", sender_type: "customer", content_type: "text", status: "delivered" } as Message);

describe("toThreadPage", () => {
  it("inverte a página decrescente para ordem crescente", () => {
    const r = toThreadPage([msg("m3", "2026-09-23T10:00:00Z"), msg("m2", "2026-09-22T10:00:00Z"), msg("m1", "2026-09-21T10:00:00Z")]);
    expect(r.messages.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("página cheia sinaliza que há mais antigas; parcial, não", () => {
    const cheia = Array.from({ length: THREAD_PAGE_SIZE }, (_, i) => msg(`m${i}`, "2026-09-23T10:00:00Z"));
    expect(toThreadPage(cheia).hasOlder).toBe(true);
    expect(toThreadPage(cheia.slice(1)).hasOlder).toBe(false);
  });

  it("não altera o array recebido", () => {
    const rows = [msg("b", "2026-09-23T10:00:00Z"), msg("a", "2026-09-22T10:00:00Z")];
    toThreadPage(rows);
    expect(rows.map((m) => m.id)).toEqual(["b", "a"]);
  });
});

describe("prependOlder", () => {
  it("coloca as antigas na frente", () => {
    const r = prependOlder([msg("m3", "2026-09-23T00:00:00Z")], [msg("m1", "2026-09-21T00:00:00Z"), msg("m2", "2026-09-22T00:00:00Z")]);
    expect(r.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("descarta a mensagem da fronteira que já estava carregada", () => {
    const fronteira = msg("m2", "2026-09-22T00:00:00Z");
    const r = prependOlder([fronteira, msg("m3", "2026-09-23T00:00:00Z")], [msg("m1", "2026-09-21T00:00:00Z"), fronteira]);
    expect(r.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("withinLoadedWindow", () => {
  const itens = [{ created_at: "2026-09-10T00:00:00Z" }, { created_at: "2026-09-20T00:00:00Z" }];

  it("corta o que é anterior à mensagem mais antiga quando há histórico por carregar", () => {
    expect(withinLoadedWindow(itens, "2026-09-15T00:00:00Z", true)).toEqual([{ created_at: "2026-09-20T00:00:00Z" }]);
  });

  it("mantém tudo quando a conversa inteira já foi carregada", () => {
    expect(withinLoadedWindow(itens, "2026-09-15T00:00:00Z", false)).toHaveLength(2);
  });

  it("mantém tudo quando não há mensagem carregada", () => {
    expect(withinLoadedWindow(itens, undefined, true)).toHaveLength(2);
  });
});
