import { describe, expect, it } from "vitest";
import { bucketHourly } from "./pulse-hourly";
import type { PulseHourlyRow } from "@/types";

const row = (hora: number, content_type: string, msgs: number): PulseHourlyRow => ({
  hora,
  content_type,
  msgs,
});

describe("bucketHourly", () => {
  it("array vazio → 24 buckets zerados (gap-filling)", () => {
    const out = bucketHourly([]);
    expect(out).toHaveLength(24);
    expect(out[0]).toEqual({ hora: 0, byType: {}, total: 0 });
    expect(out[23]).toEqual({ hora: 23, byType: {}, total: 0 });
    expect(out.every((b) => b.total === 0)).toBe(true);
  });

  it("agrega tipos repetidos na mesma hora e soma o total", () => {
    const out = bucketHourly([
      row(9, "text", 5),
      row(9, "text", 3),
      row(9, "audio", 2),
    ]);
    expect(out[9].byType).toEqual({ text: 8, audio: 2 });
    expect(out[9].total).toBe(10);
  });

  it("location e interactive caem em 'other'", () => {
    const out = bucketHourly([
      row(14, "location", 1),
      row(14, "interactive", 2),
    ]);
    expect(out[14].byType).toEqual({ other: 3 });
  });

  it("tipo arbitrário desconhecido (ex: sticker) cai em 'other'", () => {
    const out = bucketHourly([row(8, "sticker", 4)]);
    expect(out[8].byType).toEqual({ other: 4 });
  });

  it("hora fora de ordem preserva o índice do bucket", () => {
    const out = bucketHourly([row(22, "text", 1), row(3, "text", 2)]);
    expect(out[3].total).toBe(2);
    expect(out[22].total).toBe(1);
  });

  it("total = soma de byType", () => {
    const out = bucketHourly([
      row(10, "text", 7),
      row(10, "image", 1),
      row(10, "template", 2),
    ]);
    const sum = Object.values(out[10].byType).reduce((a, b) => a + (b ?? 0), 0);
    expect(out[10].total).toBe(sum);
    expect(out[10].total).toBe(10);
  });

  it("hora inválida (24, -1, não-inteira) é ignorada", () => {
    const out = bucketHourly([
      row(24, "text", 5),
      row(-1, "text", 5),
      row(2.5, "text", 5),
    ]);
    expect(out.every((b) => b.total === 0)).toBe(true);
  });
});
