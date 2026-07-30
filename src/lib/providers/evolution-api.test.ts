// ============================================================
// Testa o cliente HTTP da Evolution no boundary (MSW): asserta a URL,
// o header apikey e o body de cada request, e a normalização da
// resposta. NÃO valida o contrato real da Evolution (externo) — valida
// que o nosso cliente monta a request como esperado.
// ============================================================
import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "@/test/msw/server";
import {
  evoCreateInstance,
  evoConnect,
  evoConnectionState,
  evoSendText,
  EvolutionApiError,
  isEvoInstanceNotFound,
  isEvoNameInUse,
} from "./evolution-api";

const BASE = "http://evo.test:8080";
const KEY = "global-key";

describe("evolution-api — boundary HTTP", () => {
  it("evoSendText: POST /message/sendText/{instance}, header apikey, body {number,text}", async () => {
    let captured: { path: string; apikey: string | null; body: unknown } | null = null;
    server.use(
      http.post(`${BASE}/message/sendText/:instance`, async ({ request, params }) => {
        captured = {
          path: `/message/sendText/${params.instance as string}`,
          apikey: request.headers.get("apikey"),
          body: await request.json(),
        };
        return HttpResponse.json({ key: { id: "EVO123" } });
      }),
    );
    const r = await evoSendText({
      baseUrl: BASE, apiKey: KEY, instance: "inst1", number: "5521999990000", text: "Oi",
    });
    expect(r.messageId).toBe("EVO123");
    expect(captured).toEqual({
      path: "/message/sendText/inst1",
      apikey: KEY,
      body: { number: "5521999990000", text: "Oi" },
    });
  });

  it("evoCreateInstance: POST /instance/create com integration baileys + qrcode; extrai base64", async () => {
    let body: unknown = null;
    server.use(
      http.post(`${BASE}/instance/create`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ qrcode: { base64: "data:img/QR" } });
      }),
    );
    const r = await evoCreateInstance({ baseUrl: BASE, apiKey: KEY, instanceName: "inst1" });
    expect(r.qrBase64).toBe("data:img/QR");
    expect(body).toEqual({ instanceName: "inst1", integration: "WHATSAPP-BAILEYS", qrcode: true });
  });

  it("evoConnect: GET /instance/connect/{instance}; aceita base64 no topo ou em qrcode", async () => {
    server.use(
      http.get(`${BASE}/instance/connect/:instance`, () =>
        HttpResponse.json({ base64: "QR-TOP" }),
      ),
    );
    expect((await evoConnect({ baseUrl: BASE, apiKey: KEY, instance: "inst1" })).qrBase64).toBe("QR-TOP");
  });

  it("evoConnectionState: lê instance.state", async () => {
    server.use(
      http.get(`${BASE}/instance/connectionState/:instance`, () =>
        HttpResponse.json({ instance: { state: "open" } }),
      ),
    );
    expect((await evoConnectionState({ baseUrl: BASE, apiKey: KEY, instance: "inst1" })).state).toBe("open");
  });

  it("erro HTTP vira EvolutionApiError com status e body", async () => {
    server.use(
      http.post(`${BASE}/message/sendText/:instance`, () =>
        HttpResponse.json({ error: "bad" }, { status: 400 }),
      ),
    );
    const err = await evoSendText({
      baseUrl: BASE, apiKey: KEY, instance: "i", number: "1", text: "x",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EvolutionApiError);
    expect((err as EvolutionApiError).status).toBe(400);
    expect((err as EvolutionApiError).body).toContain("bad");
    expect((err as EvolutionApiError).message).toMatch(/Evolution API error: 400/);
  });

  it("evoConnectionState: shape desconhecido → 'unknown' (não presume queda)", async () => {
    server.use(
      http.get(`${BASE}/instance/connectionState/:instance`, () =>
        HttpResponse.json({}),
      ),
    );
    expect(
      (await evoConnectionState({ baseUrl: BASE, apiKey: KEY, instance: "i" })).state,
    ).toBe("unknown");
  });
});

describe("evolution-api — helpers de erro", () => {
  it("isEvoInstanceNotFound: true só p/ EvolutionApiError 404", () => {
    expect(isEvoInstanceNotFound(new EvolutionApiError(404, "not found"))).toBe(true);
    expect(isEvoInstanceNotFound(new EvolutionApiError(403, "x"))).toBe(false);
    expect(isEvoInstanceNotFound(new Error("Evolution API error: 404"))).toBe(false);
  });

  it("isEvoNameInUse: 403 + 'already in use' case-insensitive", () => {
    expect(
      isEvoNameInUse(new EvolutionApiError(403, '{"response":{"message":["This name \\"x\\" is already in use."]}}')),
    ).toBe(true);
    expect(isEvoNameInUse(new EvolutionApiError(403, "This name is ALREADY IN USE."))).toBe(true);
    expect(isEvoNameInUse(new EvolutionApiError(403, "forbidden"))).toBe(false);
    expect(isEvoNameInUse(new EvolutionApiError(404, "already in use"))).toBe(false);
    expect(isEvoNameInUse(new Error("already in use"))).toBe(false);
  });
});
