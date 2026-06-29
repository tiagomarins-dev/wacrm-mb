import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as Record<string, unknown> | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as { table: string; filters: [string, string, unknown][] }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    // ai_reply: conversa devolvida pelo lookup de connection_id + deletes capturados.
    conversation: null as Record<string, unknown> | null,
    deletes: [] as { table: string; filters: [string, string, unknown][] }[],
    logs: [] as unknown[],
  },
}));

vi.mock("./admin-client", () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === "contacts") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === "custom_fields") {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === "contact_custom_values") {
      if (type === "upsert") {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === "conversations") {
      if (type === "update") {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      return { data: state.conversation, error: null };
    }
    if (table === "ai_agent_pending") {
      if (type === "delete") state.deletes.push({ table, filters: ops.filters });
      return { data: null, error: null };
    }
    if (table === "automations") return { data: state.automations, error: null };
    if (table === "automation_logs") {
      // Captura insert+update p/ asserir o steps_executed (detail honesto do ai_reply).
      if (type === "insert") { state.logs.push(ops.payload); return { data: { id: "log1" }, error: null }; }
      if (type === "update") { state.logs.push(ops.payload); return { data: null, error: null }; }
      return { data: { steps_executed: [], status: "success" }, error: null };
    }
    if (table === "automation_steps") return { data: state.steps, error: null };
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: "select",
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = "insert"), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = "update"), (ops.payload = p), b),
      delete: () => ((ops.type = "delete"), b),
      upsert: (p: unknown) => ((ops.type = "upsert"), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(["eq", k, v]), b),
      gte: () => b,
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: () => Promise.resolve({ error: null }),
    }),
  };
});

vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

// Engine do agente + gate de perfil mockados — o step ai_reply só os orquestra.
vi.mock("@/lib/ai-agent/engine", () => ({
  runAiAgentForConversation: vi.fn(async () => "ok"),
}));
vi.mock("@/lib/ai-agent/dispatch", () => ({
  resolveAssignedProfile: vi.fn(async () => null),
}));

import { runAutomationsForTrigger } from "./engine";
import { runAiAgentForConversation } from "@/lib/ai-agent/engine";
import { resolveAssignedProfile } from "@/lib/ai-agent/dispatch";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.conversation = null;
  h.state.deletes = [];
  h.state.logs = [];
  vi.mocked(runAiAgentForConversation).mockClear();
  vi.mocked(resolveAssignedProfile).mockResolvedValue(null);
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(["eq", "id", "c1"]);
    expect(filters).toContainEqual(["eq", "account_id", ACCOUNT]);
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: "c1",
      custom_field_id: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

function automationWithUpdateStep() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field: "company", value: "pwned-by-automation" },
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "update_contact_field",
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

function automationWithAiReply() {
  return {
    id: "a1",
    account_id: ACCOUNT,
    user_id: "u1",
    trigger_type: "new_message_received",
    trigger_config: {},
    is_active: true,
  };
}

function aiReplyStep() {
  return {
    id: "s1",
    automation_id: "a1",
    step_type: "ai_reply",
    position: 0,
    parent_step_id: null,
    step_config: {},
  };
}

describe("ai_reply step", () => {
  // Setup comum: contato da conta + conversa com conexão + automação com o step.
  function setup() {
    h.state.owned = { id: "c1" };
    h.state.conversation = { connection_id: "conn-1" };
    h.state.automations = [automationWithAiReply()];
    h.state.steps = [aiReplyStep()];
  }

  it("chama runAiAgentForConversation com a conversa/conexão e limpa o pending", async () => {
    setup();
    vi.mocked(resolveAssignedProfile).mockResolvedValue({ id: "p1" } as never);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(vi.mocked(runAiAgentForConversation)).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: ACCOUNT,
        connection_id: "conn-1",
        conversation_id: "conv-1",
        contact_id: "c1",
        opening: true, // abertura: ai_reply marca a 1ª resposta sem handoff
      }),
    );
    expect(h.state.deletes).toHaveLength(1);
    expect(h.state.deletes[0].filters).toContainEqual([
      "eq",
      "conversation_id",
      "conv-1",
    ]);
  });

  it("loga o desfecho REAL do agente no detail do step (R3 — log honesto)", async () => {
    setup();
    vi.mocked(resolveAssignedProfile).mockResolvedValue({ id: "p1" } as never);
    // Agente no-opa por falta de config → desfecho 'skipped:disabled'.
    vi.mocked(runAiAgentForConversation).mockResolvedValueOnce("skipped:disabled" as never);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    // O steps_executed (no insert ou update do log) carrega o detail honesto.
    const stepDetails = h.state.logs
      .flatMap((l) => ((l as { steps_executed?: { detail?: string }[] })?.steps_executed) ?? [])
      .map((s) => s.detail);
    expect(stepDetails).toContain("ai_reply: skipped:disabled");
    expect(stepDetails).not.toContain("ai reply enviado");
  });

  it("NÃO chama o agente quando a conversa não está atribuída a um perfil de IA", async () => {
    setup();
    vi.mocked(resolveAssignedProfile).mockResolvedValue(null);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(vi.mocked(runAiAgentForConversation)).not.toHaveBeenCalled();
  });

  it("NÃO chama o agente quando a conversa não tem conexão", async () => {
    setup();
    h.state.conversation = { connection_id: null };
    vi.mocked(resolveAssignedProfile).mockResolvedValue({ id: "p1" } as never);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(vi.mocked(runAiAgentForConversation)).not.toHaveBeenCalled();
  });

  it("respeita ai_opt_out do contato (não chama o agente)", async () => {
    setup();
    h.state.owned = { id: "c1", ai_opt_out: true };
    vi.mocked(resolveAssignedProfile).mockResolvedValue({ id: "p1" } as never);

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { conversation_id: "conv-1" },
    });

    expect(vi.mocked(runAiAgentForConversation)).not.toHaveBeenCalled();
  });
});
