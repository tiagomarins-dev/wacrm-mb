import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

// next/headers é server-only; mockamos cookies() para controlar o
// valor do cookie em cada cenário.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
import { cookies } from "next/headers";

import { getActiveConnection, ACTIVE_CONNECTION_COOKIE } from "./active";

const mockedCookies = vi.mocked(cookies);

// UUIDs fixos (Math.random/Date proibidos no ambiente; valores estáveis).
const ACCOUNT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONN_A1 = "11111111-1111-4111-8111-111111111111"; // primária da conta A
const CONN_A2 = "22222222-2222-4222-8222-222222222222"; // 2ª conexão da conta A
const CONN_OTHER = "99999999-9999-4999-8999-999999999999"; // de outra conta

interface Row {
  id: string;
  account_id: string;
  phone_number_id: string;
  is_primary: boolean;
  access_token?: string;
}

// Fake chainable do SupabaseClient (espelha o padrão de send-engine.test.ts):
// acumula os .eq() e resolve contra `rows` no maybeSingle()/single().
function makeDb(rows: Row[]): SupabaseClient {
  function from() {
    const filters: Record<string, unknown> = {};
    const match = () =>
      rows.find((r) =>
        Object.entries(filters).every(
          ([k, v]) => (r as unknown as Record<string, unknown>)[k] === v,
        ),
      ) ?? null;
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      maybeSingle: async () => ({ data: match(), error: null }),
      single: async () => {
        const m = match();
        return m
          ? { data: m, error: null }
          : { data: null, error: { message: "no rows" } };
      },
    };
    return chain;
  }
  return { from } as unknown as SupabaseClient;
}

// Mock do retorno de cookies(): só precisa de .get(name) -> { value } | undefined.
function setCookie(value: string | null) {
  mockedCookies.mockResolvedValue({
    get: (name: string) =>
      name === ACTIVE_CONNECTION_COOKIE && value !== null
        ? { value }
        : undefined,
  } as unknown as Awaited<ReturnType<typeof cookies>>);
}

const ROWS: Row[] = [
  { id: CONN_A1, account_id: ACCOUNT_A, phone_number_id: "111", is_primary: true },
  { id: CONN_A2, account_id: ACCOUNT_A, phone_number_id: "222", is_primary: false },
];

describe("getActiveConnection", () => {
  beforeEach(() => mockedCookies.mockReset());

  it("usa a conexão do cookie quando UUID válido e da conta", async () => {
    setCookie(CONN_A2);
    const conn = await getActiveConnection(makeDb(ROWS), ACCOUNT_A);
    expect(conn.id).toBe(CONN_A2);
  });

  it("cai na primária quando o cookie é de outra conta (não vaza)", async () => {
    setCookie(CONN_OTHER); // UUID válido, mas não pertence à conta A
    const conn = await getActiveConnection(makeDb(ROWS), ACCOUNT_A);
    expect(conn.id).toBe(CONN_A1);
    expect(conn.is_primary).toBe(true);
  });

  it("cai na primária quando não há cookie", async () => {
    setCookie(null);
    const conn = await getActiveConnection(makeDb(ROWS), ACCOUNT_A);
    expect(conn.id).toBe(CONN_A1);
  });

  it("cai na primária quando o cookie não é UUID", async () => {
    setCookie("nao-e-uuid");
    const conn = await getActiveConnection(makeDb(ROWS), ACCOUNT_A);
    expect(conn.id).toBe(CONN_A1);
  });

  it("lança quando a conta não tem nenhuma conexão", async () => {
    setCookie(null);
    await expect(getActiveConnection(makeDb([]), ACCOUNT_A)).rejects.toThrow(
      /Nenhuma conexão/,
    );
  });
});
