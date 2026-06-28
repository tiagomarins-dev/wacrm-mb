// ============================================================
// Seed/cleanup E2E (projeto de teste). Usa service-role do Supabase
// de teste (E2E_SUPABASE_SERVICE_ROLE) — NUNCA prod. Cria/limpa dados
// sob um prefixo de account p/ specs hermético e re-rodável.
// ============================================================
import { createClient } from "@supabase/supabase-js";

// Cliente admin (service-role) do projeto de teste. persistSession=false
// porque é uso server-side efêmero (seed/teardown), sem cookie.
export function admin() {
  return createClient(
    process.env.E2E_SUPABASE_URL!,
    process.env.E2E_SUPABASE_SERVICE_ROLE!,
    { auth: { persistSession: false } },
  );
}
// (helpers de criação/limpeza entram nas fases A–E conforme a necessidade)
