import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  resolveOutboundConfig,
  resolveOutboundConfigForConversation,
} from "./resolve";

const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_A1 = "11111111-1111-4111-8111-111111111111"; // primária
const CONN_A2 = "22222222-2222-4222-8222-222222222222";
const CONN_OTHER = "99999999-9999-4999-8999-999999999999"; // de outra conta
const CONV_1 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Row = Record<string, unknown>;

// Fake do SupabaseClient: resolve from('<tabela>') contra um store por
// tabela, respeitando os .eq() acumulados.
function makeDb(store: Record<string, Row[]>): SupabaseClient {
  function from(table: string) {
    const filters: Record<string, unknown> = {};
    const match = () =>
      (store[table] ?? []).find((r) =>
        Object.entries(filters).every(([k, v]) => r[k] === v),
      ) ?? null;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => ({ data: match(), error: null }),
    };
    return chain;
  }
  return { from } as unknown as SupabaseClient;
}

const CONFIGS: Row[] = [
  { id: CONN_A1, account_id: ACCOUNT_A, is_primary: true, phone_number_id: "111" },
  { id: CONN_A2, account_id: ACCOUNT_A, is_primary: false, phone_number_id: "222" },
];

describe("resolveOutboundConfig", () => {
  it("retorna a config do connection_id quando pertence à conta", async () => {
    const cfg = await resolveOutboundConfig(
      makeDb({ whatsapp_config: CONFIGS }),
      ACCOUNT_A,
      CONN_A2,
    );
    expect(cfg.id).toBe(CONN_A2);
  });

  it("cai na primária quando connection_id é nulo (rollout)", async () => {
    const cfg = await resolveOutboundConfig(
      makeDb({ whatsapp_config: CONFIGS }),
      ACCOUNT_A,
      null,
    );
    expect(cfg.id).toBe(CONN_A1);
  });

  it("cai na primária quando o id é de outra conta (H1 — nunca o token alheio)", async () => {
    const cfg = await resolveOutboundConfig(
      makeDb({ whatsapp_config: CONFIGS }),
      ACCOUNT_A,
      CONN_OTHER,
    );
    expect(cfg.id).toBe(CONN_A1);
    expect(cfg.id).not.toBe(CONN_OTHER);
  });

  it("lança quando a conta não tem nenhuma conexão", async () => {
    await expect(
      resolveOutboundConfig(makeDb({ whatsapp_config: [] }), ACCOUNT_A, null),
    ).rejects.toThrow(/Nenhuma conexão/);
  });
});

describe("resolveOutboundConfigForConversation", () => {
  it("envia pela conexão DA CONVERSA (H2), não pela primária", async () => {
    const db = makeDb({
      whatsapp_config: CONFIGS,
      conversations: [
        { id: CONV_1, account_id: ACCOUNT_A, connection_id: CONN_A2 },
      ],
    });
    const cfg = await resolveOutboundConfigForConversation(db, ACCOUNT_A, CONV_1);
    expect(cfg.id).toBe(CONN_A2); // a da conversa, não a primária (CONN_A1)
  });

  it("cai na primária quando a conversa não tem connection_id (rollout)", async () => {
    const db = makeDb({
      whatsapp_config: CONFIGS,
      conversations: [
        { id: CONV_1, account_id: ACCOUNT_A, connection_id: null },
      ],
    });
    const cfg = await resolveOutboundConfigForConversation(db, ACCOUNT_A, CONV_1);
    expect(cfg.id).toBe(CONN_A1);
  });
});
