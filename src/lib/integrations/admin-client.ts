import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Client service-role para o engine de integrações. Usado SÓ no servidor
// para ler integrations_config (tabela admin-only) quando o caller é um
// agente não-admin que precisa dos tokens para enviar. Nunca em client.
// Espelha src/lib/broadcast/admin-client.ts.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}
