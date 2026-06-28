import { describe, expect, it, vi } from "vitest";
import type { WhatsAppConfig } from "@/types";
import { createMessageProvider } from "./factory";
import { ProviderCapabilityError, capabilitiesFor } from "./types";

// Config mínima p/ os testes (só os campos que a factory lê).
function cfg(
  provider?: "meta" | "evolution",
  extra?: Partial<WhatsAppConfig>,
): WhatsAppConfig {
  return {
    id: "c1",
    account_id: "a1",
    user_id: "u1",
    is_primary: true,
    phone_number_id: "1555000111",
    access_token: "enc",
    status: "connected",
    provider,
    ...extra,
  } as WhatsAppConfig;
}

describe("createMessageProvider — dispatch por provider", () => {
  it("provider 'meta' → adapter meta", () => {
    expect(createMessageProvider(cfg("meta"), "tok").id).toBe("meta");
  });

  it("provider ausente → default meta", () => {
    expect(createMessageProvider(cfg(undefined), "tok").id).toBe("meta");
  });

  it("provider 'evolution' com env + instance_name → adapter evolution", () => {
    vi.stubEnv("EVOLUTION_API_URL", "http://evo.test:8080");
    vi.stubEnv("EVOLUTION_API_KEY", "global-key");
    try {
      const p = createMessageProvider(
        cfg("evolution", { instance_name: "inst1" }),
        "tok",
      );
      expect(p.id).toBe("evolution");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("provider 'evolution' sem env/instance → lança", () => {
    vi.unstubAllEnvs();
    expect(() =>
      createMessageProvider(cfg("evolution", { instance_name: null }), "tok"),
    ).toThrow(ProviderCapabilityError);
  });
});

describe("capabilitiesFor", () => {
  it("meta: massBroadcast/template true, groups false", () => {
    const c = capabilitiesFor("meta");
    expect(c.massBroadcast).toBe(true);
    expect(c.template).toBe(true);
    expect(c.groups).toBe(false);
  });

  it("evolution: massBroadcast/template false, groups true", () => {
    const c = capabilitiesFor("evolution");
    expect(c.massBroadcast).toBe(false);
    expect(c.template).toBe(false);
    expect(c.groups).toBe(true);
  });

  it("ausente/null → meta", () => {
    expect(capabilitiesFor(undefined)).toEqual(capabilitiesFor("meta"));
    expect(capabilitiesFor(null)).toEqual(capabilitiesFor("meta"));
  });
});
