import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Client service-role compartilhado para o engine de broadcast agendado.
// Espelha o padrão de src/lib/automations/admin-client.ts — bypassa RLS,
// usado SÓ no servidor (cron). Nunca importar em código client.
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
