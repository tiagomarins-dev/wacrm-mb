// ============================================================
// Handlers MSW p/ a Evolution API (usados a partir da Fase C).
// Nesta fase ficam só registrados como esqueleto — nenhum teste
// os exercita ainda.
// ============================================================
import { http, HttpResponse } from "msw";

// POST {base}/message/sendText/{instance} — header apikey.
export function captureEvoSendText(sink: {
  req?: { path: string; apikey: string | null; rawBody: string };
}) {
  return http.post("*/message/sendText/:instance", async ({ request }) => {
    sink.req = {
      path: new URL(request.url).pathname,
      apikey: request.headers.get("apikey"),
      rawBody: await request.text(),
    };
    return HttpResponse.json({ key: { id: "EVO.GOLDEN" } });
  });
}
