// ============================================================
// Setup global do Vitest (multi-fase). Sobe o servidor MSW SEM
// handlers por padrão (onUnhandledRequest:'error'): só os testes de
// boundary registram handlers via server.use(). Os 74 testes legados
// que tocam rede usam vi.stubGlobal('fetch', …) (ex. meta-api.test.ts:28),
// que SUBSTITUI global.fetch e vence o MSW — logo seguem verdes. Testes
// de lógica pura nunca chamam fetch. 'error' garante zero rede silenciosa.
// ============================================================
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw/server";

// Sobe antes de toda a suíte; falha alto em request sem handler.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
// Limpa handlers entre testes — nenhum vazamento de mock entre arquivos.
afterEach(() => server.resetHandlers());
// Encerra ao fim da suíte.
afterAll(() => server.close());
