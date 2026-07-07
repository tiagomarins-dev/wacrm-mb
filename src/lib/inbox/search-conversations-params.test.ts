import { describe, expect, it, afterEach, vi } from "vitest";
import {
  buildSearchParams,
  resolveDateRange,
  PAGE_SIZE,
  type SearchInput,
} from "./search-conversations-params";

// Base mínima do estado da tela; cada teste sobrescreve o que importa.
// dateRange: 'all' aqui → não introduz filtro de data nos testes existentes.
const base: SearchInput = {
  search: "",
  statusFilter: "all",
  agentFilter: "all",
  activeConnectionId: null,
  page: 0,
  dateRange: "all",
};

describe("buildSearchParams", () => {
  it("padrão (tudo 'all', sem busca) → tudo null/false", () => {
    const p = buildSearchParams(base);
    expect(p).toEqual({
      p_search: null, p_status: null, p_agent: null, p_unassigned: false,
      p_connection: null, p_date_from: null, p_date_to: null,
      p_limit: PAGE_SIZE, p_offset: 0,
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

  it("data: 'all' → p_date_from/to null; 'month' → from setado", () => {
    expect(buildSearchParams({ ...base, dateRange: "all" }).p_date_from).toBeNull();
    const m = buildSearchParams({ ...base, dateRange: "month" });
    expect(m.p_date_from).not.toBeNull();
    expect(m.p_date_to).toBeNull();
  });
});

describe("resolveDateRange", () => {
  afterEach(() => vi.useRealTimers());

  // Meio do mês, fuso local — evita ambiguidade nos presets.
  const fix = (iso: string) => vi.useFakeTimers({ now: new Date(iso) });

  it("month (default) → início do mês local, to null", () => {
    fix("2026-07-15T10:00:00");
    const { from, to } = resolveDateRange("month");
    expect(from?.getDate()).toBe(1);
    expect(from?.getMonth()).toBe(6); // julho (0-based)
    expect(to).toBeNull();
  });

  it("today → início do dia local", () => {
    fix("2026-07-15T10:00:00");
    const { from } = resolveDateRange("today");
    expect(from?.getHours()).toBe(0);
    expect(from?.getDate()).toBe(15);
  });

  it("6m/12m → subMonths a partir de hoje", () => {
    fix("2026-07-15T10:00:00");
    expect(resolveDateRange("6m").from?.getMonth()).toBe(0);  // jan
    expect(resolveDateRange("12m").from?.getMonth()).toBe(6); // jul do ano anterior
  });

  it("all → {null,null}", () => {
    expect(resolveDateRange("all")).toEqual({ from: null, to: null });
  });

  it("custom válido → [startOfDay(from), endOfDay(to)]; inválido → {null,null}", () => {
    const a = new Date("2026-06-01T09:00:00");
    const b = new Date("2026-06-10T18:00:00");
    const ok = resolveDateRange("custom", a, b);
    expect(ok.from?.getDate()).toBe(1);
    expect(ok.to?.getHours()).toBe(23);
    // incompleto ou invertido → sem filtro (Todas)
    expect(resolveDateRange("custom", a, null)).toEqual({ from: null, to: null });
    expect(resolveDateRange("custom", b, a)).toEqual({ from: null, to: null });
  });

  it("virada de mês corta no fuso LOCAL, não UTC", () => {
    // 31/07 23:00 local: 'month' deve começar em 01/07 local (não 01/08 por UTC).
    fix("2026-07-31T23:00:00");
    const { from } = resolveDateRange("month");
    expect(from?.getMonth()).toBe(6); // julho
    expect(from?.getDate()).toBe(1);
  });
});
