import { describe, expect, it } from "vitest";
import { pairTurns, cappedMinutes, CAP_MINUTES, type TurnMsg } from "./response-time";

const cust = (at: string): TurnMsg => ({ sender_type: "customer", created_at: at });
const agent = (at: string, sender_id?: string | null, assigned?: string | null): TurnMsg =>
  ({ sender_type: "agent", created_at: at, sender_id, assigned_agent_id: assigned });
const bot = (at: string): TurnMsg => ({ sender_type: "bot", created_at: at });

describe("pairTurns", () => {
  it("turno simples (cliente → agente) = 1 turno, FRT", () => {
    const t = pairTurns([cust("2026-06-29T10:00:00Z"), agent("2026-06-29T10:05:00Z", "u1")]);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ custAt: "2026-06-29T10:00:00Z", respAt: "2026-06-29T10:05:00Z", responder: "u1", isFirst: true });
  });

  it("5 msgs seguidas do cliente = 1 turno (ancora na 1ª)", () => {
    const t = pairTurns([
      cust("2026-06-29T10:00:00Z"), cust("2026-06-29T10:00:10Z"), cust("2026-06-29T10:00:20Z"),
      cust("2026-06-29T10:00:30Z"), cust("2026-06-29T10:00:40Z"), agent("2026-06-29T10:05:00Z", "u1"),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].custAt).toBe("2026-06-29T10:00:00Z");
  });

  it("bot no meio é IGNORADO (não fecha o turno)", () => {
    const t = pairTurns([cust("2026-06-29T10:00:00Z"), bot("2026-06-29T10:00:30Z"), agent("2026-06-29T10:05:00Z", "u1")]);
    expect(t).toHaveLength(1);
    expect(t[0].respAt).toBe("2026-06-29T10:05:00Z"); // o agente, não o bot
  });

  it("sem resposta humana = nenhum turno (FRT nulo, não 0)", () => {
    expect(pairTurns([cust("2026-06-29T10:00:00Z")])).toHaveLength(0);
    expect(pairTurns([cust("2026-06-29T10:00:00Z"), bot("2026-06-29T10:01:00Z")])).toHaveLength(0);
  });

  it("dois turnos: 2º não é FRT", () => {
    const t = pairTurns([
      cust("2026-06-29T10:00:00Z"), agent("2026-06-29T10:05:00Z", "u1"),
      cust("2026-06-29T11:00:00Z"), agent("2026-06-29T11:02:00Z", "u2"),
    ]);
    expect(t).toHaveLength(2);
    expect(t[0].isFirst).toBe(true);
    expect(t[1].isFirst).toBe(false);
    expect(t[1].responder).toBe("u2");
  });

  it("crédito por sender_id; fallback assigned_agent_id quando null", () => {
    const t = pairTurns([cust("2026-06-29T10:00:00Z"), agent("2026-06-29T10:05:00Z", null, "u9")]);
    expect(t[0].responder).toBe("u9");
  });
});

describe("cappedMinutes", () => {
  it("trunca no cap de 4h", () => {
    expect(cappedMinutes(300 * 60)).toBe(CAP_MINUTES); // 5h → 240min
    expect(cappedMinutes(60)).toBe(1);
  });
});
