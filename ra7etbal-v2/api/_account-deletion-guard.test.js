import { describe, expect, it, vi } from 'vitest';
import {
  ACCOUNT_DELETION_BLOCK_CODE,
  assertAccountMayExecuteConsequentialAction,
  checkAccountConsequentialAccess,
} from './_account-deletion-guard.js';

const config = { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service', userId: 'owner-a' };

describe('account deletion consequential guard', () => {
  it('allows an account with no active deletion request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    await expect(checkAccountConsequentialAccess({ ...config, fetchImpl })).resolves.toEqual({ allowed: true, code: 'allowed' });
    expect(fetchImpl.mock.calls[0][0]).toContain('user_id=eq.owner-a');
  });

  it.each(['in_progress', 'failed_retryable', 'failed_requires_review'])(
    'blocks frozen status %s', async (status) => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ status }] });
      await expect(assertAccountMayExecuteConsequentialAction({ ...config, fetchImpl }))
        .rejects.toMatchObject({ code: ACCOUNT_DELETION_BLOCK_CODE, accountDeletionStatus: status });
    },
  );

  it('fails closed when state cannot be read', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network'));
    await expect(assertAccountMayExecuteConsequentialAction({ ...config, fetchImpl }))
      .rejects.toMatchObject({ code: 'account_state_unavailable' });
  });

  it('scopes each decision to the supplied tenant', async () => {
    const fetchImpl = vi.fn(async (url) => ({
      ok: true,
      json: async () => url.includes('owner-a') ? [{ status: 'in_progress' }] : [],
    }));
    await expect(assertAccountMayExecuteConsequentialAction({ ...config, fetchImpl })).rejects.toThrow();
    await expect(assertAccountMayExecuteConsequentialAction({ ...config, userId: 'owner-b', fetchImpl })).resolves.toBeUndefined();
  });
});

