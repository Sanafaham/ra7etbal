import { describe, expect, it, vi } from 'vitest';
import { processAccountDeletionCancellations } from './_account-deletion-cancellation.js';

const response = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('account deletion in-flight cancellation worker', () => {
  it('records provider confirmation and treats already-absent QStash work as confirmed', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([{ id: 'c1', lease_token: 'l1', provider: 'qstash', provider_work_id: 'm1' }]))
      .mockResolvedValueOnce(response({}, 404))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response([]));
    const result = await processAccountDeletionCancellations({
      supabaseUrl: 'https://db.test', serviceKey: 'service', qstashToken: 'qstash', fetchImpl,
    });
    expect(result).toMatchObject({ claimed: 1, confirmed: 1, unknown: 0 });
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toMatchObject({
      p_id: 'c1', p_lease_token: 'l1', p_outcome: 'external_cancellation_confirmed', p_failure_code: null,
    });
  });

  it('records an unknown provider outcome without claiming success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([{ id: 'c1', lease_token: 'l1', provider: 'qstash', provider_work_id: 'm1' }]))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response([]));
    const result = await processAccountDeletionCancellations({
      supabaseUrl: 'https://db.test', serviceKey: 'service', qstashToken: 'qstash', fetchImpl,
    });
    expect(result).toMatchObject({ claimed: 1, confirmed: 0, unknown: 1 });
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).p_outcome).toBe('external_outcome_unknown');
  });

  it('does nothing without cancellation credentials while local freeze remains authoritative', async () => {
    const fetchImpl = vi.fn();
    expect(await processAccountDeletionCancellations({
      supabaseUrl: 'https://db.test', serviceKey: 'service', qstashToken: '', fetchImpl,
    })).toEqual({ claimed: 0, confirmed: 0, unknown: 0, failed: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stops automatic retries after the bounded attempt limit', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response([{
        id: 'c1', lease_token: 'l1', provider: 'qstash', provider_work_id: 'm1', attempt_count: 5,
      }]))
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response(true))
      .mockResolvedValueOnce(response([]));
    await processAccountDeletionCancellations({
      supabaseUrl: 'https://db.test', serviceKey: 'service', qstashToken: 'qstash', fetchImpl,
    });
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).p_outcome).toBe('failed_requires_review');
  });
});
