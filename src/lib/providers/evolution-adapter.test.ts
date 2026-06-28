import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import { createEvolutionAdapter } from "./evolution-adapter";
import { ProviderCapabilityError } from "./types";

const adapter = createEvolutionAdapter({
  baseUrl: "http://evo.test:8080",
  apiKey: "k",
  instance: "inst1",
});

describe("EvolutionAdapter (fase C)", () => {
  it("sendText chama /message/sendText e normaliza messageId", async () => {
    server.use(
      http.post("http://evo.test:8080/message/sendText/:instance", () =>
        HttpResponse.json({ key: { id: "EVO9" } }),
      ),
    );
    const r = await adapter.sendText({ to: "5521999990000", text: "Oi" });
    expect(r.messageId).toBe("EVO9");
  });

  it("capabilities: groups true, template/massBroadcast false", () => {
    expect(adapter.capabilities.groups).toBe(true);
    expect(adapter.capabilities.template).toBe(false);
    expect(adapter.capabilities.massBroadcast).toBe(false);
  });

  it("sendMedia/sendTemplate/sendReaction/interactive lançam CapabilityError", async () => {
    await expect(adapter.sendMedia({ to: "1", kind: "image", link: "x" })).rejects.toThrow(ProviderCapabilityError);
    await expect(adapter.sendTemplate({ to: "1", templateName: "t" })).rejects.toThrow(ProviderCapabilityError);
    await expect(adapter.sendReaction({ to: "1", targetMessageId: "m", emoji: "👍" })).rejects.toThrow(ProviderCapabilityError);
    await expect(adapter.sendInteractiveButtons({ to: "1", bodyText: "b", buttons: [{ id: "a", title: "A" }] })).rejects.toThrow(ProviderCapabilityError);
  });

  it("sendTyping é no-op (não lança)", async () => {
    await expect(adapter.sendTyping({ messageId: "m" })).resolves.toBeUndefined();
  });
});
