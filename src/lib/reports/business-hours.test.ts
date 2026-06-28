import { describe, expect, it } from "vitest";
import { businessSecondsBetween, type ScheduleEntry } from "./business-hours";

const SP = "America/Sao_Paulo";
// Seg a sex 09:00–18:00 (dow 1..5). SP não tem DST desde 2019.
const WEEK: ScheduleEntry[] = [1, 2, 3, 4, 5].map((dow) => ({ dow, enabled: true, open: "09:00", close: "18:00" }));

describe("businessSecondsBetween", () => {
  it("dentro do expediente (seg 10:00→10:05) = 300s", () => {
    expect(businessSecondsBetween(new Date("2026-06-29T10:00:00-03:00"), new Date("2026-06-29T10:05:00-03:00"), WEEK, SP)).toBe(300);
  });

  it("overnight (seg 22:00 → ter 09:05) só conta expediente = 0 (seg fechou 18h, ter abre 9h)", () => {
    // seg 22:00 já fora; ter antes das 09:00 → nada some
    expect(businessSecondsBetween(new Date("2026-06-29T22:00:00-03:00"), new Date("2026-06-30T08:30:00-03:00"), WEEK, SP)).toBe(0);
  });

  it("fim de semana (domingo, dow off) = 0", () => {
    expect(businessSecondsBetween(new Date("2026-06-28T10:00:00-03:00"), new Date("2026-06-28T12:00:00-03:00"), WEEK, SP)).toBe(0);
  });

  it("cliente fora (08:00) / resposta dentro (09:10) → clipa ao open = 600s", () => {
    expect(businessSecondsBetween(new Date("2026-06-29T08:00:00-03:00"), new Date("2026-06-29T09:10:00-03:00"), WEEK, SP)).toBe(600);
  });

  it("sem schedule → 24/7 (diff bruto) = 3600s", () => {
    expect(businessSecondsBetween(new Date("2026-06-28T10:00:00-03:00"), new Date("2026-06-28T11:00:00-03:00"), [], SP)).toBe(3600);
  });

  it("cruza dois dias úteis (seg 17:00 → ter 09:30) = 1h seg + 0,5h ter = 5400s", () => {
    expect(businessSecondsBetween(new Date("2026-06-29T17:00:00-03:00"), new Date("2026-06-30T09:30:00-03:00"), WEEK, SP)).toBe(5400);
  });

  it("fim < início = 0", () => {
    expect(businessSecondsBetween(new Date("2026-06-29T11:00:00-03:00"), new Date("2026-06-29T10:00:00-03:00"), WEEK, SP)).toBe(0);
  });

  it("DST (Europe/London) — domingo do spring-forward conta 1h a menos que domingo normal", () => {
    const LON = "Europe/London";
    const SUN: ScheduleEntry[] = [{ dow: 0, enabled: true, open: "00:00", close: "12:00" }];
    // 2026-03-29 = início do BST (relógio 01:00→02:00). 00:00–12:00 local = 11h reais.
    const springFwd = businessSecondsBetween(new Date("2026-03-29T00:00:00Z"), new Date("2026-03-29T11:00:00Z"), SUN, LON);
    expect(springFwd).toBe(11 * 3600);
    // 2026-03-22 = domingo normal (GMT). 00:00–12:00 local = 12h.
    const normal = businessSecondsBetween(new Date("2026-03-22T00:00:00Z"), new Date("2026-03-22T12:00:00Z"), SUN, LON);
    expect(normal).toBe(12 * 3600);
  });
});
