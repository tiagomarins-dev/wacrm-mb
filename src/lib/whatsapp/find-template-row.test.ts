import { describe, it, expect } from "vitest";
import { findTemplateRow } from "./find-template-row";

// Fake Supabase: registra os .eq() aplicados e resolve no .maybeSingle()
// a linha que casa o connection_id pedido (simula o filtro do banco e o
// erro multiple-rows quando 2+ linhas casam sem filtro).
function makeDb(rows: { connection_id: string }[]) {
  const eqs: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      eqs[col] = val;
      return chain;
    },
    maybeSingle: () => {
      const filtered = eqs.connection_id
        ? rows.filter((r) => r.connection_id === eqs.connection_id)
        : rows;
      if (filtered.length > 1) {
        return Promise.resolve({ data: null, error: { message: "multiple rows" } });
      }
      return Promise.resolve({ data: filtered[0] ?? null, error: null });
    },
  };
  return { from: () => chain } as never;
}

describe("findTemplateRow", () => {
  it("filtra por conexão quando há mesmo nome em 2 conexões", async () => {
    const db = makeDb([{ connection_id: "conn-A" }, { connection_id: "conn-B" }]);
    const row = await findTemplateRow(db, {
      accountId: "acc",
      connectionId: "conn-B",
      name: "promo",
      language: "pt_BR",
    });
    expect(row).not.toBeNull();
    expect((row as { connection_id: string }).connection_id).toBe("conn-B");
  });

  it("sem connectionId, mesmo nome em 2 conexões → null (multiple rows)", async () => {
    const db = makeDb([{ connection_id: "conn-A" }, { connection_id: "conn-B" }]);
    const row = await findTemplateRow(db, {
      accountId: "acc",
      name: "promo",
      language: "pt_BR",
    });
    expect(row).toBeNull();
  });
});
