import { describe, expect, it, vi } from 'vitest';
import { processAccountDeletionRelational } from './_account-deletion-relational.js';

const response = (body, ok = true) => ({ ok, json: async () => body });

describe('Slice C relational worker', () => {
  it('claims and executes only the server-derived request and lease', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([{ request_id: 'request-a', lease_token: 'lease-a' }]))
      .mockResolvedValueOnce(response(true));
    const result = await processAccountDeletionRelational({
      supabaseUrl: 'https://example.supabase.co', serviceKey: 'service', fetchImpl,
    });
    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0 });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({
      p_request_id: 'request-a', p_lease_token: 'lease-a',
    });
    expect(fetchImpl.mock.calls[0][1].body).not.toContain('user_id');
  });

  it('records a retryable failure without exposing provider/database detail', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([{ request_id: 'request-a', lease_token: 'lease-a' }]))
      .mockResolvedValueOnce(response({ message: 'sensitive database detail' }, false))
      .mockResolvedValueOnce(response(true));
    expect(await processAccountDeletionRelational({
      supabaseUrl: 'https://example.supabase.co', serviceKey: 'service', fetchImpl,
    })).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toMatchObject({
      p_failure_code: 'relational_execution_failed', p_requires_review: false,
    });
  });

  it('is inert without service credentials or claimable work', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response([]));
    expect(await processAccountDeletionRelational({ fetchImpl })).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(await processAccountDeletionRelational({
      supabaseUrl: 'https://example.supabase.co', serviceKey: 'service', fetchImpl,
    })).toEqual({ claimed: 0, completed: 0, failed: 0 });
  });
});
