import { describe, expect, it } from "vitest";
import { mergeStatuses, resolveStatus, SYSTEM_STATUS_DEFAULTS } from "./conversation-statuses";
import type { ConversationStatusRow } from "@/types";

// Monta uma row de banco com defaults preenchidos.
const row = (o: Partial<ConversationStatusRow>): ConversationStatusRow => ({
  id: "r", account_id: "a", key: "x", label: "X", color: "#000000",
  is_system: false, sort_order: 0, created_at: "", ...o,
});

describe("mergeStatuses", () => {
  it("rows undefined → 3 defaults de sistema", () => {
    const r = mergeStatuses(undefined);
    expect(r.map((s) => s.key)).toEqual(["open", "pending", "closed"]);
  });

  it("banco sobrescreve label/cor do system (por key)", () => {
    const r = mergeStatuses([row({ key: "open", label: "Nova", color: "#ff0000", is_system: true })]);
    const open = r.find((s) => s.key === "open");
    expect(open?.label).toBe("Nova");
    expect(open?.color).toBe("#ff0000");
    expect(r).toHaveLength(3); // não duplica
  });

  it("custom é anexado à lista", () => {
    const r = mergeStatuses([row({ key: "pago", label: "Aguardando pagto", sort_order: 5 })]);
    expect(r.map((s) => s.key)).toContain("pago");
    expect(r).toHaveLength(4);
  });

  it("ordena por sort_order", () => {
    const r = mergeStatuses([row({ key: "z", label: "Z", sort_order: -1 })]);
    expect(r[0].key).toBe("z"); // sort_order -1 vem antes de open(0)
  });

  it("não muta SYSTEM_STATUS_DEFAULTS", () => {
    mergeStatuses([row({ key: "open", label: "Alterada", is_system: true })]);
    expect(SYSTEM_STATUS_DEFAULTS.find((s) => s.key === "open")?.label).toBe("Aberta");
  });
});

describe("resolveStatus", () => {
  const list = mergeStatuses([row({ key: "pago", label: "Pago", color: "#8b5cf6" })]);

  it("key conhecida → label+cor", () => {
    expect(resolveStatus(list, "pago")).toEqual({ label: "Pago", color: "#8b5cf6" });
    expect(resolveStatus(list, "open").label).toBe("Aberta");
  });

  it("key órfã → fallback neutro (a própria key + cinza)", () => {
    expect(resolveStatus(list, "sumiu")).toEqual({ label: "sumiu", color: "#94a3b8" });
  });
});
