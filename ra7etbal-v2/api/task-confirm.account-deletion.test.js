import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_account-deletion-guard.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkAccountConsequentialAccess: vi.fn(async () => ({
    allowed: false, code: 'account_deletion_in_progress', status: 'in_progress',
  })),
}));

const { handleTaskConfirmationPost } = await import('./task-confirm.js');

describe('task confirmation after account deletion freeze', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', 'https://db.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service');
  });

  it('rejects a stale confirmation before mutation or external execution', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [{ id: 'task-1', user_id: 'owner-a', status: 'pending', description: 'Do it' }],
    }));
    vi.stubGlobal('fetch', fetchMock);
    const req = { body: { taskId: 'task-1', confirmedBy: 'worker' } };
    const res = {
      statusCode: 200,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    await handleTaskConfirmationPost(req, res);
    expect(res.statusCode).toBe(409);
    expect(res.payload.code).toBe('account_deletion_in_progress');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([, init]) => ['PATCH', 'POST'].includes(init?.method))).toBe(false);
  });
});
