// ============================================================
// GOLDEN do wire Meta. Dirige cada função de envio de meta-api.ts
// através do MSW e grava (método+path+authScheme+contentType+rawBody)
// num snapshot. É a rede de regressão da Fase B: o MetaAdapter terá
// que produzir EXATAMENTE este wire (toMatchSnapshot SEM -u).
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

const CRED = { phoneNumberId: "1555000111", accessToken: "tok-GOLDEN" };
const TO = "5521999990000";

// Captura o wire de um envio e devolve o objeto canônico p/ snapshot.
async function wireOf(run: () => Promise<unknown>): Promise<CapturedRequest> {
  const sink: { req?: CapturedRequest } = {};
  server.use(captureMetaSend(sink));
  await run();
  if (!sink.req) throw new Error("nenhuma request capturada");
  return sink.req;
}

describe("golden: wire Meta (baseline p/ Fase B)", () => {
  it("sendText", async () => {
    expect(
      await wireOf(() => sendTextMessage({ ...CRED, to: TO, text: "Olá" })),
    ).toMatchSnapshot();
  });

  it("sendText com context (reply)", async () => {
    expect(
      await wireOf(() =>
        sendTextMessage({
          ...CRED,
          to: TO,
          text: "Re",
          contextMessageId: "wamid.PARENT",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("sendMedia (image link)", async () => {
    expect(
      await wireOf(() =>
        sendMediaMessage({
          ...CRED,
          to: TO,
          kind: "image",
          link: "https://x/i.jpg",
          caption: "c",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("sendTemplate", async () => {
    expect(
      await wireOf(() =>
        sendTemplateMessage({
          ...CRED,
          to: TO,
          templateName: "hello_world",
          language: "pt_BR",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("sendReaction", async () => {
    expect(
      await wireOf(() =>
        sendReactionMessage({
          ...CRED,
          to: TO,
          targetMessageId: "wamid.T",
          emoji: "👍",
        }),
      ),
    ).toMatchSnapshot();
  });

  it("sendTypingIndicator", async () => {
    expect(
      await wireOf(() =>
        sendTypingIndicator({ ...CRED, messageId: "wamid.LAST" }),
      ),
    ).toMatchSnapshot();
  });

  it("sendInteractiveButtons", async () => {
    expect(
      await wireOf(() =>
        sendInteractiveButtons({
          ...CRED,
          to: TO,
          bodyText: "B",
          buttons: [{ id: "a", title: "A" }],
        }),
      ),
    ).toMatchSnapshot();
  });

  it("sendInteractiveList", async () => {
    expect(
      await wireOf(() =>
        sendInteractiveList({
          ...CRED,
          to: TO,
          bodyText: "B",
          buttonLabel: "Abrir",
          sections: [{ title: "S", rows: [{ id: "r1", title: "R1" }] }],
        }),
      ),
    ).toMatchSnapshot();
  });
});
