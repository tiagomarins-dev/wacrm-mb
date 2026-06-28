import { describe, expect, it } from "vitest";
import { normalizeEvolutionInbound } from "./evolution-inbound";
import type { EvoRecord } from "./evolution-api";

// Records espelhando o shape real do container (Fase C).
function rec(over: Partial<EvoRecord>): EvoRecord {
  return {
    key: { id: "M1", fromMe: false, remoteJid: "5521999990000@s.whatsapp.net" },
    pushName: "Aluna",
    messageType: "conversation",
    message: { conversation: "Oi" },
    messageTimestamp: 1782674766,
    ...over,
  };
}

describe("normalizeEvolutionInbound", () => {
  it("texto (conversation)", () => {
    const n = normalizeEvolutionInbound(rec({}))!;
    expect(n).toMatchObject({
      messageId: "M1", phone: "5521999990000", name: "Aluna",
      fromMe: false, contentType: "text", contentText: "Oi", hasMedia: false, timestamp: 1782674766,
    });
  });

  it("extendedTextMessage → text", () => {
    const n = normalizeEvolutionInbound(
      rec({ messageType: "extendedTextMessage", message: { extendedTextMessage: { text: "Olá" } } }),
    )!;
    expect(n.contentType).toBe("text");
    expect(n.contentText).toBe("Olá");
  });

  it("imageMessage com caption → image + hasMedia", () => {
    const n = normalizeEvolutionInbound(
      rec({ messageType: "imageMessage", message: { imageMessage: { caption: "foto" } } }),
    )!;
    expect(n.contentType).toBe("image");
    expect(n.hasMedia).toBe(true);
    expect(n.contentText).toBe("foto");
  });

  it("audioMessage → audio, contentText null", () => {
    const n = normalizeEvolutionInbound(rec({ messageType: "audioMessage", message: {} }))!;
    expect(n.contentType).toBe("audio");
    expect(n.contentText).toBeNull();
  });

  it("fromMe preservado", () => {
    const n = normalizeEvolutionInbound(rec({ key: { id: "M2", fromMe: true, remoteJid: "5521999990000@s.whatsapp.net" } }))!;
    expect(n.fromMe).toBe(true);
  });

  it("@lid resolve o telefone real via remoteJidAlt", () => {
    const n = normalizeEvolutionInbound(
      rec({
        key: {
          id: "L1", fromMe: false,
          remoteJid: "146862799614006@lid",
          remoteJidAlt: "5521967394997@s.whatsapp.net",
          addressingMode: "lid",
        },
      }),
    )!;
    expect(n.phone).toBe("5521967394997");
    expect(n.messageId).toBe("L1");
  });

  it("@lid sem remoteJidAlt → null", () => {
    expect(
      normalizeEvolutionInbound(rec({ key: { id: "L2", remoteJid: "999@lid" } })),
    ).toBeNull();
  });

  it("grupo (@g.us) → isGroup + chatId + senderName/Phone do participante", () => {
    const n = normalizeEvolutionInbound(
      rec({
        key: {
          id: "G1", fromMe: false,
          remoteJid: "120363012345678901@g.us",
          participant: "146862799614006@lid",
          participantAlt: "5521994593232@s.whatsapp.net",
        },
        pushName: "Camilla Ramos",
        message: { conversation: "Oi grupo" },
      }),
    )!;
    expect(n.isGroup).toBe(true);
    expect(n.chatId).toBe("120363012345678901@g.us");
    expect(n.phone).toBe(""); // grupo não usa phone
    expect(n.senderName).toBe("Camilla Ramos");
    expect(n.senderPhone).toBe("5521994593232");
    expect(n.contentText).toBe("Oi grupo");
    expect(n.messageId).toBe("G1");
  });

  it("grupo sem participantAlt → senderName cai no pushName, senderPhone null", () => {
    const n = normalizeEvolutionInbound(
      rec({ key: { id: "G2", remoteJid: "120363@g.us" }, pushName: "Fulano" }),
    )!;
    expect(n.isGroup).toBe(true);
    expect(n.senderName).toBe("Fulano");
    expect(n.senderPhone).toBeNull();
  });

  it("1:1 mantém isGroup=false e campos de grupo nulos", () => {
    const n = normalizeEvolutionInbound(rec({}))!;
    expect(n.isGroup).toBe(false);
    expect(n.chatId).toBeNull();
    expect(n.senderName).toBeNull();
    expect(n.senderPhone).toBeNull();
  });

  it("ephemeralMessage (1:1): desembrulha extendedTextMessage → text", () => {
    const n = normalizeEvolutionInbound(
      rec({
        messageType: "ephemeralMessage",
        message: { ephemeralMessage: { message: { extendedTextMessage: { text: "some efêmero" } } } },
      }),
    )!;
    expect(n.contentType).toBe("text");
    expect(n.contentText).toBe("some efêmero");
  });

  it("ephemeralMessage (grupo): desembrulha imageMessage + caption", () => {
    const n = normalizeEvolutionInbound(
      rec({
        key: {
          id: "GE1", fromMe: false,
          remoteJid: "120363@g.us",
          participantAlt: "5521994593232@s.whatsapp.net",
        },
        pushName: "Loja",
        messageType: "ephemeralMessage",
        message: { ephemeralMessage: { message: { imageMessage: { caption: "promo" } } } },
      }),
    )!;
    expect(n.isGroup).toBe(true);
    expect(n.contentType).toBe("image");
    expect(n.hasMedia).toBe(true);
    expect(n.contentText).toBe("promo");
    expect(n.senderName).toBe("Loja");
  });

  it("ephemeralMessage com conteúdo não suportado → null", () => {
    expect(
      normalizeEvolutionInbound(
        rec({
          messageType: "ephemeralMessage",
          message: { ephemeralMessage: { message: { locationMessage: {} } } },
        }),
      ),
    ).toBeNull();
  });

  it("tipo não suportado → null", () => {
    expect(normalizeEvolutionInbound(rec({ messageType: "locationMessage" }))).toBeNull();
  });

  it("sem id → null", () => {
    expect(normalizeEvolutionInbound(rec({ key: { remoteJid: "5521999990000@s.whatsapp.net" } }))).toBeNull();
  });
});
