import { describe, it, expect, vi } from "vitest";
import { syncConnectionTemplates, type ConnLite } from "./template-sync";

// Fake do SupabaseClient: chainable + thenable. O lookup (select→maybeSingle)
// resolve por `existing`; insert/update registram em `store`.
function makeDb(existing: { id: string } | null) {
  const store = { inserts: [] as Record<string, unknown>[], updates: [] as Record<string, unknown>[] };
  function from() {
    const state: { op: string; row?: Record<string, unknown> } = { op: "select" };
    const chain: Record<string, unknown> = {
      select: () => chain,
      insert: (row: Record<string, unknown>) => {
        store.inserts.push(row);
        return Promise.resolve({ error: null });
      },
      update: (row: Record<string, unknown>) => {
        state.op = "update";
        state.row = row;
        return chain;
      },
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: existing, error: null }),
      // `update(row).eq('id', x)` é awaited diretamente → thenable.
      then: (res: (v: { error: null }) => unknown) => {
        if (state.op === "update" && state.row) store.updates.push(state.row);
        return Promise.resolve({ error: null }).then(res);
      },
    };
    return chain;
  }
  return { db: { from } as never, store };
}

function fakeFetch(templates: unknown[]) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: templates, paging: {} }),
  })) as unknown as typeof fetch;
}

const conn: ConnLite = { id: "conn-1", waba_id: "waba-1", access_token: "tok" };
const tpl = (name: string) => ({
  id: `meta-${name}`,
  name,
  language: "pt_BR",
  status: "APPROVED",
  category: "MARKETING",
  components: [{ type: "BODY", text: "oi" }],
});

describe("syncConnectionTemplates", () => {
  it("insere templates novos com connection_id da conexão", async () => {
    const { db, store } = makeDb(null);
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", fakeFetch([tpl("a"), tpl("b")]));
    expect(r.total).toBe(2);
    expect(r.inserted).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.errors).toHaveLength(0);
    expect(store.inserts[0].connection_id).toBe("conn-1");
    expect(store.inserts[0].account_id).toBe("acc-1");
  });

  it("atualiza quando já existe a linha da conexão", async () => {
    const { db, store } = makeDb({ id: "row-1" });
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", fakeFetch([tpl("a")]));
    expect(r.updated).toBe(1);
    expect(r.inserted).toBe(0);
    expect(store.updates).toHaveLength(1);
  });

  it("pula conexão sem waba_id sem tocar a rede", async () => {
    const { db } = makeDb(null);
    const fetchSpy = fakeFetch([tpl("a")]);
    const r = await syncConnectionTemplates(
      db,
      { ...conn, waba_id: null },
      "acc-1",
      "user-1",
      fetchSpy,
    );
    expect(r.total).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("coleta erro da Meta e não aborta o processo", async () => {
    const { db } = makeDb(null);
    const failFetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", failFetch);
    expect(r.errors).toHaveLength(1);
    expect(r.inserted).toBe(0);
  });
});
