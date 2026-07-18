import { describe, expect, it } from "vitest";
import {
  generateWebhookToken,
  validateWebhookMetaTemplateFirst,
} from "./webhook-token";
import type { SupabaseClient } from "@supabase/supabase-js";

// Admin fake mínimo: só o caminho whatsapp_config.select('provider').
function adminWithProvider(provider: string | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({
            data: provider === null ? null : { provider },
            error: null,
          }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

const SEND_MESSAGE_FIRST = [
  { step_type: "send_message", step_config: { text: "oi" } },
];
const TEMPLATE_FIRST = [
  { step_type: "send_template", step_config: { template_name: "x" } },
];

describe("generateWebhookToken", () => {
  it("gera wh_ + 32 hex, único por chamada", () => {
    const a = generateWebhookToken();
    const b = generateWebhookToken();
    expect(a).toMatch(/^wh_[0-9a-f]{32}$/);
    expect(b).toMatch(/^wh_[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});

describe("validateWebhookMetaTemplateFirst", () => {
  it("bloqueia send_message primeiro em conexão meta", async () => {
    const issues = await validateWebhookMetaTemplateFirst(
      adminWithProvider("meta"),
      "conn-1",
      SEND_MESSAGE_FIRST,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("steps");
  });

  it("provider ausente é tratado como meta (padrão da mig 056)", async () => {
    const issues = await validateWebhookMetaTemplateFirst(
      adminWithProvider(null),
      "conn-1",
      SEND_MESSAGE_FIRST,
    );
    expect(issues).toHaveLength(1);
  });

  it("permite send_message em conexão evolution", async () => {
    const issues = await validateWebhookMetaTemplateFirst(
      adminWithProvider("evolution"),
      "conn-1",
      SEND_MESSAGE_FIRST,
    );
    expect(issues).toEqual([]);
  });

  it("permite template primeiro em conexão meta", async () => {
    const issues = await validateWebhookMetaTemplateFirst(
      adminWithProvider("meta"),
      "conn-1",
      TEMPLATE_FIRST,
    );
    expect(issues).toEqual([]);
  });
});
