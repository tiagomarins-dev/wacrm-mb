// ============================================================
// A garantia que este módulo dá é NEGATIVA: nunca cair em outra conexão. Por
// isso os casos importantes aqui são os de falha — e o espião que prova que a
// consulta jamais filtra por is_primary, que é o fallback de resolveOutboundConfig.
// ============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSupportConnectionId,
  resolveSupportConfig,
  SupportConnectionError,
} from "./support";
import type { SupabaseClient } from "@supabase/supabase-js";

const ID = "50cb7049-b827-47f4-bf39-cd5b2883883f";
const CONTA = "ad2de49f-eca2-47f5-9c6b-236145eb4d5c";

/** Client falso que registra os filtros aplicados e devolve a linha combinada. */
function fakeDb(row: unknown) {
  const eqs: Array<[string, unknown]> = [];
  let selecionado = "";
  const builder: Record<string, unknown> = {
    select: (cols: string) => {
      selecionado = cols;
      return builder;
    },
    eq: (col: string, val: unknown) => {
      eqs.push([col, val]);
      return builder;
    },
    maybeSingle: async () => ({ data: row }),
  };
  return {
    db: { from: () => builder } as unknown as SupabaseClient,
    eqs,
    select: () => selecionado,
  };
}

beforeEach(() => {
  vi.stubEnv("SUPPORT_CONNECTION_ID", ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSupportConnectionId", () => {
  it("devolve o id configurado", () => {
    expect(getSupportConnectionId()).toBe(ID);
  });

  it("devolve null quando a env não existe", () => {
    vi.stubEnv("SUPPORT_CONNECTION_ID", "");
    expect(getSupportConnectionId()).toBeNull();
  });

  it("devolve null quando o valor não é UUID", () => {
    vi.stubEnv("SUPPORT_CONNECTION_ID", "suporte");
    expect(getSupportConnectionId()).toBeNull();
  });

  it("tolera espaço em volta do valor", () => {
    vi.stubEnv("SUPPORT_CONNECTION_ID", `  ${ID}  `);
    expect(getSupportConnectionId()).toBe(ID);
  });
});

describe("resolveSupportConfig", () => {
  it("devolve a config no happy path", async () => {
    const { db } = fakeDb({
      id: ID,
      user_id: "u1",
      account_id: CONTA,
      archived_at: null,
    });
    const config = await resolveSupportConfig(db, CONTA);
    expect(config.id).toBe(ID);
    expect(config.user_id).toBe("u1");
  });

  it("escopa por id E account_id, e nunca consulta is_primary", async () => {
    // is_primary aqui seria o fallback silencioso que este módulo existe p/ evitar.
    const { db, eqs, select } = fakeDb({
      id: ID,
      user_id: "u1",
      account_id: CONTA,
      archived_at: null,
    });
    await resolveSupportConfig(db, CONTA);

    expect(eqs).toEqual([
      ["id", ID],
      ["account_id", CONTA],
    ]);
    expect(eqs.map(([col]) => col)).not.toContain("is_primary");
    // E o token cifrado não entra num caminho que não envia mensagem.
    expect(select()).not.toContain("access_token");
    expect(select()).not.toContain("*");
  });

  it("lança unconfigured quando a env falta", async () => {
    vi.stubEnv("SUPPORT_CONNECTION_ID", "");
    const { db } = fakeDb(null);
    await expect(resolveSupportConfig(db, CONTA)).rejects.toMatchObject({
      reason: "unconfigured",
    });
  });

  it("lança unconfigured quando a env não é UUID", async () => {
    vi.stubEnv("SUPPORT_CONNECTION_ID", "nao-e-uuid");
    const { db } = fakeDb(null);
    await expect(resolveSupportConfig(db, CONTA)).rejects.toMatchObject({
      reason: "unconfigured",
    });
  });

  it("lança not_in_account quando o id é de outra conta", async () => {
    // maybeSingle devolve null porque o .eq('account_id') não casou.
    const { db } = fakeDb(null);
    await expect(resolveSupportConfig(db, CONTA)).rejects.toMatchObject({
      reason: "not_in_account",
    });
  });

  it("lança archived quando a conexão foi arquivada", async () => {
    const { db } = fakeDb({
      id: ID,
      user_id: "u1",
      account_id: CONTA,
      archived_at: "2026-07-09T19:54:49Z",
    });
    await expect(resolveSupportConfig(db, CONTA)).rejects.toMatchObject({
      reason: "archived",
    });
  });

  it("o erro é um SupportConnectionError", async () => {
    vi.stubEnv("SUPPORT_CONNECTION_ID", "");
    const { db } = fakeDb(null);
    await expect(resolveSupportConfig(db, CONTA)).rejects.toBeInstanceOf(
      SupportConnectionError,
    );
  });
});
