// ============================================================
// Servidor MSW base (node). Sem handlers fixos: cada teste de
// boundary chama server.use(...) com o handler do seu cenário.
// ============================================================
import { setupServer } from "msw/node";

export const server = setupServer();
