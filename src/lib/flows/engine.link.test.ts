import { describe, it, expect } from "vitest";
import { resumeRunOnLinkClick, timeoutBranch } from "./engine";
import type { LinkTokenPayload } from "@/lib/link-tracking/token";

// ============================================================
// Mock de DB minimalista — resumeRunOnLinkClick/timeoutBranch recebem o
// `db` por argumento, então basta um builder encadeável falso. Os flows
// de teste usam wait_for_link_click → end (auto-advance), evitando
// engineSendText (sem chamada à Meta). Padrão espelha automations/engine.test.ts.
// ============================================================

interface Captured {
  link_clicks: Record<string, unknown>[];
  events: Record<string, unknown>[];
  runUpdates: Record<string, unknown>[];
}

function makeDb(
  runRow: Record<string, unknown> | null,
  nodeRows: Record<string, unknown>[],
) {
  const cap: Captured = { link_clicks: [], events: [], runUpdates: [] };

  function builder(table: string) {
    const op = { table, type: "select" as string, payload: null as unknown };
    const resolve = () => {
      if (op.type === "insert") {
        if (table === "link_clicks") cap.link_clicks.push(op.payload as Record<string, unknown>);
        if (table === "flow_run_events") cap.events.push(op.payload as Record<string, unknown>);
        return { data: { id: "x" }, error: null };
      }
      if (op.type === "update") {
        if (table === "flow_runs") cap.runUpdates.push(op.payload as Record<string, unknown>);
        return { data: [{ id: "run" }], error: null };
      }
      if (table === "flow_runs") return { data: runRow, error: null };
      if (table === "flow_nodes") return { data: nodeRows, error: null };
      return { data: null, error: null };
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((op.type = "insert"), (op.payload = p), b),
      update: (p: unknown) => ((op.type = "update"), (op.payload = p), b),
      delete: () => ((op.type = "delete"), b),
      upsert: (p: unknown) => ((op.type = "upsert"), (op.payload = p), b),
      eq: () => b,
      is: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      filter: () => b,
      maybeSingle: () => Promise.resolve(resolve()),
      single: () => Promise.resolve(resolve()),
      then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) =>
        Promise.resolve(resolve()).then(f, r),
    };
    return b;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: { from: (t: string) => builder(t) } as any, cap };
}

const RUN_ID = "run-1";
const FLOW_ID = "flow-1";
const WAIT_KEY = "wait_link";

function makeRun(over: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    flow_id: FLOW_ID,
    account_id: "acc-1",
    user_id: "user-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    status: "active",
    current_node_key: WAIT_KEY,
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    started_at: new Date(0).toISOString(),
    last_advanced_at: new Date(0).toISOString(),
    ended_at: null,
    end_reason: null,
    ...over,
  };
}

function makeNodes(waitCfg: Record<string, unknown>) {
  return [
    {
      id: "n-wait",
      flow_id: FLOW_ID,
      node_key: WAIT_KEY,
      node_type: "wait_for_link_click",
      config: waitCfg,
      position_x: 0,
      position_y: 0,
      created_at: new Date(0).toISOString(),
    },
    {
      id: "n-end",
      flow_id: FLOW_ID,
      node_key: "end_node",
      node_type: "end",
      config: {},
      position_x: 0,
      position_y: 0,
      created_at: new Date(0).toISOString(),
    },
  ];
}

const payload = (over: Partial<LinkTokenPayload> = {}): LinkTokenPayload => ({
  flow_id: FLOW_ID,
  run_id: RUN_ID,
  node_key: WAIT_KEY,
  contact_id: "contact-1",
  url: "https://example.com/x",
  ...over,
});

describe("resumeRunOnLinkClick", () => {
  it("clique válido → grava link_clicks + evento link_clicked + avança", async () => {
    const { db, cap } = makeDb(
      makeRun(),
      makeNodes({ on_click_next_node_key: "end_node" }),
    );
    await resumeRunOnLinkClick(db, payload(), "Mozilla/5.0");
    expect(cap.link_clicks).toHaveLength(1);
    expect(cap.link_clicks[0].target_url).toBe("https://example.com/x");
    expect(cap.events.some((e) => e.event_type === "link_clicked")).toBe(true);
    // avançou pro end → run encerrada
    expect(cap.runUpdates.some((u) => u.status === "completed")).toBe(true);
  });

  it("no-op se run não está ativa", async () => {
    const { db, cap } = makeDb(
      makeRun({ status: "completed" }),
      makeNodes({ on_click_next_node_key: "end_node" }),
    );
    await resumeRunOnLinkClick(db, payload(), null);
    expect(cap.link_clicks).toHaveLength(0);
  });

  it("no-op se flow_id diverge (token antigo / colisão de node_key)", async () => {
    const { db, cap } = makeDb(
      makeRun({ flow_id: "other-flow" }),
      makeNodes({ on_click_next_node_key: "end_node" }),
    );
    await resumeRunOnLinkClick(db, payload(), null);
    expect(cap.link_clicks).toHaveLength(0);
  });

  it("no-op se current_node_key diverge (run já avançou)", async () => {
    const { db, cap } = makeDb(
      makeRun({ current_node_key: "outro" }),
      makeNodes({ on_click_next_node_key: "end_node" }),
    );
    await resumeRunOnLinkClick(db, payload(), null);
    expect(cap.link_clicks).toHaveLength(0);
  });
});

describe("timeoutBranch", () => {
  it("dentro da janela → skip (não mexe na run)", async () => {
    const { db, cap } = makeDb(
      makeRun({ last_advanced_at: new Date().toISOString() }),
      makeNodes({ on_click_next_node_key: "end_node", timeout_seconds: 3600 }),
    );
    const r = await timeoutBranch(db, RUN_ID, 24);
    expect(r).toBe("skip");
    expect(cap.runUpdates).toHaveLength(0);
  });

  it("janela vencida + on_timeout → ramifica (branched)", async () => {
    const { db, cap } = makeDb(
      makeRun({ last_advanced_at: new Date(0).toISOString() }),
      makeNodes({
        on_click_next_node_key: "end_node",
        on_timeout_next_node_key: "end_node",
        timeout_seconds: 10,
      }),
    );
    const r = await timeoutBranch(db, RUN_ID, 24);
    expect(r).toBe("branched");
    expect(cap.events.some((e) => e.event_type === "timeout")).toBe(true);
  });

  it("janela vencida sem on_timeout → encerra (branched + timed_out)", async () => {
    const { db, cap } = makeDb(
      makeRun({ last_advanced_at: new Date(0).toISOString() }),
      makeNodes({ on_click_next_node_key: "end_node", timeout_seconds: 10 }),
    );
    const r = await timeoutBranch(db, RUN_ID, 24);
    expect(r).toBe("branched");
    expect(cap.runUpdates.some((u) => u.status === "timed_out")).toBe(true);
  });

  it("nó atual não é de link → not_waiting", async () => {
    const nodes = [
      {
        id: "n-end",
        flow_id: FLOW_ID,
        node_key: WAIT_KEY,
        node_type: "send_message",
        config: { text: "x", next_node_key: "end_node" },
        position_x: 0,
        position_y: 0,
        created_at: new Date(0).toISOString(),
      },
    ];
    const { db, cap } = makeDb(makeRun(), nodes);
    const r = await timeoutBranch(db, RUN_ID, 24);
    expect(r).toBe("not_waiting");
    expect(cap.runUpdates).toHaveLength(0);
  });
});
