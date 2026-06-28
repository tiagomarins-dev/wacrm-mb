// ============================================================
// Prova de byte-identidade do MetaAdapter (regressão-crítico, Fase B):
// p/ cada método, captura o wire do envio DIRETO (meta-api.ts) e do
// envio VIA ADAPTER e assere que são idênticos. Se divergir 1 byte,
// o teste quebra — garante que o refactor não mudou o payload Meta.
// ============================================================
import { describe, expect, it } from "vitest";
import { server } from "@/test/msw/server";
import { captureMetaSend, type CapturedRequest } from "@/test/msw/handlers/meta";
import {
  sendTextMessage,
  sendMediaMessage,
  sendTemplateMessage,
  sendReactionMessage,
  sendTypingIndicator,
  sendInteractiveButtons,
  sendInteractiveList,
} from "@/lib/whatsapp/meta-api";
import { createMetaAdapter } from "./meta-adapter";

const CRED = { phoneNumberId: "1555000111", accessToken: "tok-GOLDEN" };
const TO = "5521999990000";
const adapter = createMetaAdapter(CRED);

// Captura o wire de um envio (registra handler novo; o mais recente vence).
async function wire(run: () => Promise<unknown>): Promise<CapturedRequest> {
  const sink: { req?: CapturedRequest } = {};
  server.use(captureMetaSend(sink));
  await run();
  if (!sink.req) throw new Error("nenhuma request capturada");
  return sink.req;
}

describe("MetaAdapter — wire idêntico ao envio direto", () => {
  it("sendText", async () => {
    const direct = await wire(() => sendTextMessage({ ...CRED, to: TO, text: "Olá" }));
    const via = await wire(() => adapter.sendText({ to: TO, text: "Olá" }));
    expect(via).toEqual(direct);
  });

  it("sendText com context (reply)", async () => {
    const args = { to: TO, text: "Re", contextMessageId: "wamid.P" };
    const direct = await wire(() => sendTextMessage({ ...CRED, ...args }));
    const via = await wire(() => adapter.sendText(args));
    expect(via).toEqual(direct);
  });

  it("sendMedia", async () => {
    const args = { to: TO, kind: "image" as const, link: "https://x/i.jpg", caption: "c" };
    const direct = await wire(() => sendMediaMessage({ ...CRED, ...args }));
    const via = await wire(() => adapter.sendMedia(args));
    expect(via).toEqual(direct);
  });

  it("sendTemplate", async () => {
    const args = { to: TO, templateName: "hello_world", language: "pt_BR" };
    const direct = await wire(() => sendTemplateMessage({ ...CRED, ...args }));
    const via = await wire(() => adapter.sendTemplate(args));
    expect(via).toEqual(direct);
  });

  it("sendReaction", async () => {
    const args = { to: TO, targetMessageId: "wamid.T", emoji: "👍" };
    const direct = await wire(() => sendReactionMessage({ ...CRED, ...args }));
    const via = await wire(() => adapter.sendReaction(args));
    expect(via).toEqual(direct);
  });

  it("sendTyping", async () => {
    const direct = await wire(() => sendTypingIndicator({ ...CRED, messageId: "wamid.L" }));
    const via = await wire(() => adapter.sendTyping({ messageId: "wamid.L" }));
    expect(via).toEqual(direct);
  });

  it("sendInteractiveButtons", async () => {
    const args = { to: TO, bodyText: "B", buttons: [{ id: "a", title: "A" }] };
    const direct = await wire(() => sendInteractiveButtons({ ...CRED, ...args }));
    const via = await wire(() => adapter.sendInteractiveButtons(args));
    expect(via).toEqual(direct);
  });

  it("sendInteractiveList", async () => {
    const args = {
      to: TO, bodyText: "B", buttonLabel: "Abrir",
      sections: [{ title: "S", rows: [{ id: "r1", title: "R1" }] }],
    };
    const direct = await wire(() => sendInteractiveList({ ...CRED, ...args }));
    const via = await wire(() => adapter.sendInteractiveList(args));
    expect(via).toEqual(direct);
  });
});
