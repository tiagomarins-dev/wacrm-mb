import { describe, it, expect } from "vitest";
import { withConversation } from "./media-url";

describe("withConversation", () => {
  it("anexa conversationId à URL do proxy", () => {
    expect(withConversation("/api/whatsapp/media/abc", "conv-1")).toBe(
      "/api/whatsapp/media/abc?conversationId=conv-1",
    );
  });

  it("devolve intacta sem conversationId (fallback)", () => {
    expect(withConversation("/api/whatsapp/media/abc")).toBe(
      "/api/whatsapp/media/abc",
    );
    expect(withConversation("/api/whatsapp/media/abc", null)).toBe(
      "/api/whatsapp/media/abc",
    );
    expect(withConversation("/api/whatsapp/media/abc", "")).toBe(
      "/api/whatsapp/media/abc",
    );
  });

  it("devolve intacta para URL externa/não-proxy", () => {
    expect(withConversation("https://cdn.x/img.jpg", "conv-1")).toBe(
      "https://cdn.x/img.jpg",
    );
  });

  it("usa & quando já há query string", () => {
    expect(withConversation("/api/whatsapp/media/abc?v=2", "conv-1")).toBe(
      "/api/whatsapp/media/abc?v=2&conversationId=conv-1",
    );
  });

  it("encoda id com caractere especial", () => {
    // URLSearchParams usa form-urlencoding: espaço vira '+', '/' vira '%2F'.
    // O backend (searchParams.get) decodifica '+' de volta p/ espaço — round-trip ok.
    expect(withConversation("/api/whatsapp/media/abc", "a/b c")).toBe(
      "/api/whatsapp/media/abc?conversationId=a%2Fb+c",
    );
  });
});
