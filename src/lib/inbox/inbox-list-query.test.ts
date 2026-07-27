import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInboxListFilter,
  isInboxListTruncated,
  mergeKeepingActive,
  resolveDeepLink,
  shouldMergeIntoInboxList,
  INBOX_LIST_LIMIT,
  MAX_FAVORITE_IDS_IN_FILTER,
} from "./inbox-list-query";
import type { Conversation } from "@/types";

// UUID determinístico por índice — o filtro descarta o que não casa com o
// formato, então as fixtures precisam ser UUIDs de verdade.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// Fixture mínima de conversa (só os campos que os helpers leem).
function conv(over: Partial<Conversation>): Conversation {
  return {
    id: uuid(1),
    status: "open",
    connection_id: "conn-1",
    ...over,
  } as unknown as Conversation;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildInboxListFilter", () => {
  it("sem favoritas → só a cláusula de status (id.in.() vazio é inválido no PostgREST)", () => {
    expect(buildInboxListFilter([])).toBe("status.neq.closed");
  });

  it("com favoritas → soma id.in.(...)", () => {
    const f = buildInboxListFilter([uuid(2), uuid(3)]);
    expect(f).toBe(`status.neq.closed,id.in.(${uuid(2)},${uuid(3)})`);
  });

  it("descarta id malformado sem lançar", () => {
    expect(() => buildInboxListFilter(["nao-e-uuid"])).not.toThrow();
    expect(buildInboxListFilter(["nao-e-uuid"])).toBe("status.neq.closed");
    // Injeção de sintaxe de filtro não sobrevive à validação.
    expect(buildInboxListFilter([`${uuid(2)}),status.eq.closed,id.in.(`])).toBe(
      "status.neq.closed",
    );
  });

  it("acima do cap trunca de forma determinística", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const muitos = Array.from({ length: MAX_FAVORITE_IDS_IN_FILTER + 50 }, (_, i) => uuid(i));
    const a = buildInboxListFilter(muitos);
    const b = buildInboxListFilter([...muitos].reverse());
    expect(a).toBe(b); // ordem de entrada não muda o resultado
    const ids = a.slice(a.indexOf("id.in.(") + 7, -1).split(",");
    expect(ids).toHaveLength(MAX_FAVORITE_IDS_IN_FILTER);
  });

  it("avisa ao truncar (corte silencioso é o bug que este módulo corrige)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildInboxListFilter(Array.from({ length: MAX_FAVORITE_IDS_IN_FILTER + 1 }, (_, i) => uuid(i)));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("não avisa quando cabe no cap", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildInboxListFilter([uuid(2), uuid(3)]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("saída não tem vírgula nem parêntese solto", () => {
    const f = buildInboxListFilter([uuid(2)]);
    expect(f).not.toMatch(/,,|\(\)|,\)/);
    expect(f.split("(").length).toBe(f.split(")").length);
  });
});

describe("resolveDeepLink", () => {
  const base = { deepLinkId: uuid(9), consumedId: null, activeId: null };

  it("id novo → fetch (nunca procura na lista: ela é truncada)", () => {
    expect(resolveDeepLink(base)).toEqual({ kind: "fetch", id: uuid(9) });
  });

  it("já consumido → none", () => {
    expect(resolveDeepLink({ ...base, consumedId: uuid(9) })).toEqual({ kind: "none" });
  });

  it("já é a conversa ativa → none", () => {
    expect(resolveDeepLink({ ...base, activeId: uuid(9) })).toEqual({ kind: "none" });
  });

  it("sem deep-link → none", () => {
    expect(resolveDeepLink({ ...base, deepLinkId: null })).toEqual({ kind: "none" });
  });
});

describe("shouldMergeIntoInboxList", () => {
  const favs = new Set([uuid(7)]);
  const ctx = { activeConnectionId: "conn-1", favoriteIds: favs };

  it("aberta da conexão ativa entra", () => {
    expect(shouldMergeIntoInboxList(conv({}), ctx)).toBe(true);
  });

  it("finalizada não-favorita fica fora", () => {
    expect(shouldMergeIntoInboxList(conv({ status: "closed" }), ctx)).toBe(false);
  });

  it("finalizada FAVORITA entra (queue.ts:45 pina em Minhas)", () => {
    expect(shouldMergeIntoInboxList(conv({ id: uuid(7), status: "closed" }), ctx)).toBe(true);
  });

  it("de outra conexão fica fora, mesmo aberta", () => {
    expect(shouldMergeIntoInboxList(conv({ connection_id: "conn-2" }), ctx)).toBe(false);
  });

  it("sem conexão ativa não bloqueia por conexão", () => {
    expect(
      shouldMergeIntoInboxList(conv({ connection_id: "conn-2" }), {
        activeConnectionId: null,
        favoriteIds: favs,
      }),
    ).toBe(true);
  });

  it("connection_id ausente com conexão ativa → fora (o tipo permite undefined)", () => {
    expect(shouldMergeIntoInboxList(conv({ connection_id: undefined }), ctx)).toBe(false);
  });
});

describe("isInboxListTruncated", () => {
  it("total maior que as linhas → truncado", () => {
    expect(isInboxListTruncated({ rows: 1000, total: 1166, limit: 1000 })).toBe(true);
  });

  it("total igual às linhas → não truncado", () => {
    expect(isInboxListTruncated({ rows: 818, total: 818, limit: 1000 })).toBe(false);
  });

  it("exatamente no limite não é truncamento (rows === limit sozinho erraria)", () => {
    expect(isInboxListTruncated({ rows: 1000, total: 1000, limit: 1000 })).toBe(false);
  });

  it("sem count não dá para afirmar truncamento", () => {
    expect(isInboxListTruncated({ rows: 1000, total: null, limit: 1000 })).toBe(false);
  });
});

describe("mergeKeepingActive", () => {
  it("ativa ausente entra no topo, sem duplicar", () => {
    const ativa = conv({ id: uuid(5) });
    const r = mergeKeepingActive([conv({ id: uuid(1) })], ativa);
    expect(r).toHaveLength(2);
    expect(r[0].id).toBe(uuid(5));
  });

  it("ativa já presente não duplica", () => {
    const ativa = conv({ id: uuid(1) });
    const r = mergeKeepingActive([conv({ id: uuid(1) }), conv({ id: uuid(2) })], ativa);
    expect(r).toHaveLength(2);
  });

  it("sem ativa devolve a MESMA referência (evita re-render à toa)", () => {
    const loaded = [conv({ id: uuid(1) })];
    expect(mergeKeepingActive(loaded, null)).toBe(loaded);
  });

  it("ativa já presente devolve a MESMA referência", () => {
    const loaded = [conv({ id: uuid(1) })];
    expect(mergeKeepingActive(loaded, conv({ id: uuid(1) }))).toBe(loaded);
  });
});

describe("invariantes", () => {
  // Acima de 1000 o PostgREST capa em silêncio (db-max-rows) — um limite maior
  // daria falsa sensação de correção.
  it("INBOX_LIST_LIMIT não passa do db-max-rows do PostgREST", () => {
    expect(INBOX_LIST_LIMIT).toBeLessThanOrEqual(1000);
  });
});
