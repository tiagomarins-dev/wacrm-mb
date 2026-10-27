import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canCallerManageTemplates } from './template-access';

// Cliente falso: só o `rpc` importa para o helper.
function fakeClient(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn().mockResolvedValue(result);
  return { client: { rpc } as unknown as SupabaseClient, rpc };
}

describe('canCallerManageTemplates', () => {
  it('chama a RPC com a conta e libera quando ela devolve true', async () => {
    const { client, rpc } = fakeClient({ data: true, error: null });
    await expect(canCallerManageTemplates(client, 'acc-1')).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('can_manage_templates', {
      target_account_id: 'acc-1',
    });
  });

  it('nega quando a RPC devolve false', async () => {
    const { client } = fakeClient({ data: false, error: null });
    await expect(canCallerManageTemplates(client, 'acc-1')).resolves.toBe(
      false
    );
  });

  it('nega quando a RPC dá erro (ex.: função ainda não criada)', async () => {
    const { client } = fakeClient({
      data: null,
      error: { message: 'function does not exist' },
    });
    await expect(canCallerManageTemplates(client, 'acc-1')).resolves.toBe(
      false
    );
  });
});
