// ============================================================
// Handlers MSW p/ a Graph API (Meta). captureMetaSend() devolve um
// handler que grava método/URL/headers/raw-body de cada POST /messages,
// e responde com um wamid fixo — base p/ os golden tests do wire Meta.
// ============================================================
import { http, HttpResponse } from "msw";

export interface CapturedRequest {
  method: string;
  // só o path estável (sem host), p/ o golden não depender de versão da API
  path: string;
  authScheme: string; // "Bearer" se Authorization presente
  contentType: string | null;
  rawBody: string; // corpo cru — byte-identity do payload
}

// Cria um handler que captura a próxima request e responde sucesso.
// `sink` é preenchido pelo teste (objeto mutável) p/ asserção posterior.
export function captureMetaSend(sink: { req?: CapturedRequest }) {
  return http.post(
    "https://graph.facebook.com/:version/:phoneId/messages",
    async ({ request }) => {
      const auth = request.headers.get("authorization") ?? "";
      sink.req = {
        method: request.method,
        path: new URL(request.url).pathname,
        authScheme: auth.startsWith("Bearer ")
          ? "Bearer"
          : auth
            ? "other"
            : "none",
        contentType: request.headers.get("content-type"),
        rawBody: await request.text(),
      };
      return HttpResponse.json({ messages: [{ id: "wamid.GOLDEN" }] });
    },
  );
}
