import { describe, it, expect, vi } from "vitest";
import { syncConnectionTemplates, type ConnLite } from "./template-sync";

type Row = Record<string, unknown>;
type Existing = { id: string; name: string; language: string };

interface FakeOpts {
  // Linhas que a leitura dos existentes devolve.
  existing?: Existing[];
  // Mensagem de erro da leitura dos existentes.
  selectError?: string;
  // Mensagem de erro do upsert em lote.
  upsertError?: string;
  // Nomes de template cuja gravação individual (insert/update) falha.
  failNames?: string[];
}

// Fake do SupabaseClient: chainable + thenable. Cada `from()` conta como
// uma ida ao banco (`calls`); `store` registra o que cada operação recebeu.
function makeDb(opts: FakeOpts = {}) {
  const store = {
    calls: 0,
    selects: 0,
    upserts: [] as { rows: Row[]; onConflict?: string }[],
    inserts: [] as Row[],
    updates: [] as { row: Row; id: unknown }[],
  };
  const existing = opts.existing ?? [];
  const rowError = (row: Row) =>
    opts.failNames?.includes(row.name as string)
      ? { message: `linha inválida: ${row.name}` }
      : null;

  function from() {
    store.calls++;
    const state: { op: string; row?: Row; id?: unknown; range?: [number, number] } = {
      op: "select",
    };
    const chain: Record<string, unknown> = {
      select: () => {
        store.selects++;
        return chain;
      },
      order: () => chain,
      range: (a: number, b: number) => {
        state.range = [a, b];
        return chain;
      },
      eq: (col: string, val: unknown) => {
        if (state.op === "update" && col === "id") state.id = val;
        return chain;
      },
      upsert: (rows: Row[], o?: { onConflict?: string }) => {
        store.upserts.push({ rows, onConflict: o?.onConflict });
        return Promise.resolve({
          error: opts.upsertError ? { message: opts.upsertError } : null,
        });
      },
      insert: (row: Row) => {
        const error = rowError(row);
        if (!error) store.inserts.push(row);
        return Promise.resolve({ error });
      },
      update: (row: Row) => {
        state.op = "update";
        state.row = row;
        return chain;
      },
      // `select…range()` e `update(row).eq('id', x)` são awaited direto.
      then: (res: (v: unknown) => unknown) => {
        if (state.op === "update" && state.row) {
          const error = rowError(state.row);
          if (!error) store.updates.push({ row: state.row, id: state.id });
          return Promise.resolve({ error }).then(res);
        }
        if (opts.selectError) {
          return Promise.resolve({
            data: null,
            error: { message: opts.selectError },
          }).then(res);
        }
        const [a, b] = state.range ?? [0, existing.length];
        return Promise.resolve({
          data: existing.slice(a, b + 1),
          error: null,
        }).then(res);
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
const tpl = (name: string, language = "pt_BR", status = "APPROVED") => ({
  id: `meta-${name}-${language}`,
  name,
  language,
  status,
  category: "MARKETING",
  components: [{ type: "BODY", text: "oi" }],
});
const row = (name: string, language = "pt_BR"): Existing => ({
  id: `row-${name}-${language}`,
  name,
  language,
});

describe("syncConnectionTemplates", () => {
  it("insere templates novos com connection_id da conexão", async () => {
    const { db, store } = makeDb();
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", fakeFetch([tpl("a"), tpl("b")]));
    expect(r.total).toBe(2);
    expect(r.inserted).toBe(2);
    expect(r.updated).toBe(0);
    expect(r.errors).toHaveLength(0);
    expect(store.upserts[0].rows[0].connection_id).toBe("conn-1");
    expect(store.upserts[0].rows[0].account_id).toBe("acc-1");
  });

  it("atualiza quando já existe a linha da conexão", async () => {
    const { db, store } = makeDb({ existing: [row("a")] });
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", fakeFetch([tpl("a")]));
    expect(r.updated).toBe(1);
    expect(r.inserted).toBe(0);
    expect(store.upserts).toHaveLength(1);
  });

  it("faz duas idas ao banco, qualquer que seja o número de templates", async () => {
    const { db, store } = makeDb({ existing: [row("t0"), row("t1")] });
    const many = Array.from({ length: 60 }, (_, i) => tpl(`t${i}`));
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", fakeFetch(many));
    expect(store.calls).toBe(2);
    expect(store.selects).toBe(1);
    expect(store.upserts).toHaveLength(1);
    expect(store.upserts[0].rows).toHaveLength(60);
    expect(store.upserts[0].onConflict).toBe("connection_id,name,language");
    expect(r).toMatchObject({ total: 60, inserted: 58, updated: 2, errors: [] });
  });

  it("classifica novo/existente por nome + idioma", async () => {
    const { db } = makeDb({ existing: [row("a", "pt_BR")] });
    const r = await syncConnectionTemplates(
      db,
      conn,
      "acc-1",
      "user-1",
      fakeFetch([tpl("a", "pt_BR"), tpl("a", "en_US")]),
    );
    expect(r.updated).toBe(1);
    expect(r.inserted).toBe(1);
  });

  it("pagina a leitura dos existentes além do teto de 1000 linhas", async () => {
    const existing = Array.from({ length: 1001 }, (_, i) => row(`t${i}`));
    const { db, store } = makeDb({ existing });
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", fakeFetch([tpl("t1000")]));
    expect(store.selects).toBe(2);
    expect(r.updated).toBe(1);
    expect(r.inserted).toBe(0);
  });

  it("grava uma linha só quando a Meta repete nome + idioma", async () => {
    const { db, store } = makeDb();
    const r = await syncConnectionTemplates(
      db,
      conn,
      "acc-1",
      "user-1",
      fakeFetch([tpl("a", "pt_BR", "PENDING"), tpl("a", "pt_BR", "APPROVED"), tpl("b")]),
    );
    expect(store.upserts[0].rows).toHaveLength(2);
    expect(store.upserts[0].rows[0].status).toBe("APPROVED");
    expect(r.total).toBe(3);
    expect(r.inserted).toBe(2);
  });

  it("refaz o lote linha a linha e aponta só o template que falhou", async () => {
    const { db, store } = makeDb({
      existing: [row("a")],
      upsertError: "violates check constraint",
      failNames: ["ruim"],
    });
    const r = await syncConnectionTemplates(
      db,
      conn,
      "acc-1",
      "user-1",
      fakeFetch([tpl("a"), tpl("ruim"), tpl("c")]),
    );
    expect(r.total).toBe(3);
    expect(r.updated).toBe(1);
    expect(r.inserted).toBe(1);
    expect(r.errors).toEqual([
      { name: "ruim", language: "pt_BR", message: "linha inválida: ruim" },
    ]);
    // Existente vai por update no id lido; novo vai por insert.
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0].id).toBe("row-a-pt_BR");
    expect(store.inserts.map((i) => i.name)).toEqual(["c"]);
  });

  it("não grava a conexão quando a leitura dos existentes falha", async () => {
    const { db, store } = makeDb({ selectError: "timeout" });
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", fakeFetch([tpl("a")]));
    expect(r.total).toBe(1);
    expect(r.inserted).toBe(0);
    expect(r.updated).toBe(0);
    expect(r.errors).toEqual([{ name: "*", language: "*", message: "timeout" }]);
    expect(store.upserts).toHaveLength(0);
  });

  it("pula conexão sem waba_id sem tocar a rede", async () => {
    const { db, store } = makeDb();
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
    expect(store.calls).toBe(0);
  });

  it("coleta erro da Meta e não aborta o processo", async () => {
    const { db, store } = makeDb();
    const failFetch = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })) as unknown as typeof fetch;
    const r = await syncConnectionTemplates(db, conn, "acc-1", "user-1", failFetch);
    expect(r.errors).toHaveLength(1);
    expect(r.inserted).toBe(0);
    expect(store.calls).toBe(0);
  });
});
