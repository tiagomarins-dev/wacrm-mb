import { describe, expect, it } from "vitest";
import { mergeThread } from "./thread-merge";
import type { Message, ConversationEvent } from "@/types";

const msg = (id: string, at: string): Message =>
  ({ id, created_at: at, conversation_id: "c", sender_type: "customer", content_type: "text", status: "delivered" } as Message);
const evt = (id: string, at: string): ConversationEvent =>
  ({ id, created_at: at, account_id: "a", conversation_id: "c", type: "transferred" });

describe("mergeThread", () => {
  it("evento entre mensagens fica no meio (ordem cronológica)", () => {
    const r = mergeThread(
      [msg("m1", "2026-06-27T00:00:00Z"), msg("m2", "2026-06-27T00:00:02Z")],
      [evt("e1", "2026-06-27T00:00:01Z")],
    );
    expect(r.map((i) => i.id)).toEqual(["m1", "e1", "m2"]);
    expect(r[1].kind).toBe("event");
  });

  it("mesmo created_at → tie-break determinístico por id", () => {
    const r = mergeThread([msg("b", "2026-06-27T00:00:00Z")], [evt("a", "2026-06-27T00:00:00Z")]);
    expect(r.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("listas vazias → []", () => {
    expect(mergeThread([], [])).toEqual([]);
  });

  it("só eventos / só mensagens", () => {
    expect(mergeThread([], [evt("e1", "2026-06-27T00:00:00Z")]).map((i) => i.kind)).toEqual(["event"]);
    expect(mergeThread([msg("m1", "2026-06-27T00:00:00Z")], []).map((i) => i.kind)).toEqual(["message"]);
  });
});
