import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Pergunta ao banco (helper SQL `can_manage_templates`, migration 094) se quem
 * chama pode criar, editar, reenviar, excluir ou sincronizar templates.
 *
 * As rotas de template chamam a Meta antes de gravar no banco, e o RLS só
 * barra a gravação local. Sem esta checagem no início da rota, um membro sem
 * permissão alteraria o template na Meta e o banco ficaria desencontrado.
 * Erro na RPC conta como "não pode".
 */
export async function canCallerManageTemplates(
  supabase: SupabaseClient,
  accountId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_manage_templates', {
    target_account_id: accountId,
  });
  return !error && data === true;
}

/** Corpo do 403 devolvido pelas rotas de template. */
export const TEMPLATE_FORBIDDEN_MESSAGE =
  'You do not have permission to manage message templates.';
