import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePulseWindow } from "./pulse-params";

// Fixa o relógio (espelha search-conversations-params.test.ts).
const fix = (iso: string) => vi.useFakeTimers({ now: new Date(iso) });
afterEach(() => vi.useRealTimers());

describe("resolvePulseWindow", () => {
  it("today → from = 00:00 local, to = agora, endsNow", () => {
    fix("2026-07-17T15:30:00");
    const w = resolvePulseWindow("today")!;
    expect(w.from.getHours()).toBe(0);
    expect(w.from.getDate()).toBe(17);
    expect(w.to.getTime()).toBe(Date.now());
    expect(w.endsNow).toBe(true);
    expect(w.windowDays).toBe(1);
  });

  it("7d → from = 7 dias atrás 00:00 local; windowDays 7-8", () => {
    fix("2026-07-17T15:30:00");
    const w = resolvePulseWindow("7d")!;
    expect(w.from.getDate()).toBe(10);
    expect(w.from.getHours()).toBe(0);
    expect(w.windowDays).toBeGreaterThanOrEqual(7);
    expect(w.windowDays).toBeLessThanOrEqual(8);
  });

  it("30d/90d → janelas maiores, endsNow", () => {
    fix("2026-07-17T12:00:00");
    expect(resolvePulseWindow("30d")!.endsNow).toBe(true);
    expect(resolvePulseWindow("90d")!.windowDays).toBeGreaterThanOrEqual(90);
  });

  it("month → from = dia 1 do mês local", () => {
    fix("2026-07-17T12:00:00");
    const w = resolvePulseWindow("month")!;
    expect(w.from.getDate()).toBe(1);
    expect(w.from.getMonth()).toBe(6);
  });

  it("janela anterior é contígua e do mesmo tamanho", () => {
    fix("2026-07-17T12:00:00");
    const w = resolvePulseWindow("30d")!;
    expect(w.prevTo.getTime()).toBe(w.from.getTime());
    expect(w.prevTo.getTime() - w.prevFrom.getTime()).toBe(w.to.getTime() - w.from.getTime());
  });

  it("custom válido → from 00:00, to fim do dia; passado → endsNow false", () => {
    fix("2026-07-17T12:00:00");
    const w = resolvePulseWindow("custom", new Date("2026-06-01T00:00"), new Date("2026-06-30T00:00"))!;
    expect(w.from.getHours()).toBe(0);
    expect(w.to.getDate()).toBe(30);
    expect(w.to.getHours()).toBe(23);
    expect(w.endsNow).toBe(false);
  });

  it("custom terminando hoje → endsNow true e to clampado a agora", () => {
    fix("2026-07-17T12:00:00");
    const w = resolvePulseWindow("custom", new Date("2026-07-10T00:00"), new Date("2026-07-17T00:00"))!;
    expect(w.endsNow).toBe(true);
    expect(w.to.getTime()).toBe(Date.now());
  });

  it("custom invertido → null", () => {
    fix("2026-07-17T12:00:00");
    expect(resolvePulseWindow("custom", new Date("2026-07-10T00:00"), new Date("2026-07-01T00:00"))).toBeNull();
  });

  it("custom incompleto → null", () => {
    fix("2026-07-17T12:00:00");
    expect(resolvePulseWindow("custom", new Date("2026-07-10T00:00"), null)).toBeNull();
    expect(resolvePulseWindow("custom", null, new Date("2026-07-10T00:00"))).toBeNull();
  });
});
