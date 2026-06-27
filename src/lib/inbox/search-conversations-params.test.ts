import { describe, expect, it } from "vitest";
import { buildSearchParams, PAGE_SIZE, type SearchInput } from "./search-conversations-params";

// Base mínima do estado da tela; cada teste sobrescreve o que importa.
const base: SearchInput = {
  search: "",
  statusFilter: "all",
  agentFilter: "all",
  activeConnectionId: null,
  page: 0,
};

describe("buildSearchParams", () => {
  it("padrão (tudo 'all', sem busca) → tudo null/false", () => {
    const p = buildSearchParams(base);
    expect(p).toEqual({
      p_search: null, p_status: null, p_agent: null, p_unassigned: false,
      p_connection: null, p_limit: PAGE_SIZE, p_offset: 0,
    });
  });

  it("status: 'all' → null; valor real → passa", () => {
    expect(buildSearchParams({ ...base, statusFilter: "all" }).p_status).toBeNull();
    expect(buildSearchParams({ ...base, statusFilter: "open" }).p_status).toBe("open");
  });

  it("atendente: 'all' → p_agent null/unassigned false", () => {
    const p = buildSearchParams({ ...base, agentFilter: "all" });
    expect(p.p_agent).toBeNull();
    expect(p.p_unassigned).toBe(false);
  });

  it("atendente: 'unassigned' → p_agent null + p_unassigned true", () => {
    const p = buildSearchParams({ ...base, agentFilter: "unassigned" });
    expect(p.p_agent).toBeNull();
    expect(p.p_unassigned).toBe(true);
  });

  it("atendente: uuid (humano/perfil/bot) → p_agent=uuid, unassigned false", () => {
    const bot = "00000000-0000-0000-0000-0000000000a1";
    expect(buildSearchParams({ ...base, agentFilter: bot }).p_agent).toBe(bot);
    expect(buildSearchParams({ ...base, agentFilter: "perfil-1" }).p_agent).toBe("perfil-1");
    expect(buildSearchParams({ ...base, agentFilter: "perfil-1" }).p_unassigned).toBe(false);
  });

  // R5: busca em mensagens só com termo >= 3 chars.
  it("busca: <3 chars → p_search null; >=3 → passa; trim conta", () => {
    expect(buildSearchParams({ ...base, search: "ab" }).p_search).toBeNull();
    expect(buildSearchParams({ ...base, search: "abc" }).p_search).toBe("abc");
    expect(buildSearchParams({ ...base, search: "  a  " }).p_search).toBeNull(); // trim→1
    expect(buildSearchParams({ ...base, search: "  curso  " }).p_search).toBe("curso"); // trim aplicado
  });

  it("conexão e paginação", () => {
    expect(buildSearchParams({ ...base, activeConnectionId: "conn-1" }).p_connection).toBe("conn-1");
    expect(buildSearchParams({ ...base, page: 2 }).p_offset).toBe(2 * PAGE_SIZE);
    expect(buildSearchParams(base).p_limit).toBe(PAGE_SIZE);
  });
});
