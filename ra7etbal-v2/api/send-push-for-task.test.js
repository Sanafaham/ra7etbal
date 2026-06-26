import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  verify: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: mocks.sendNotification,
  },
}));

vi.mock('@upstash/qstash', () => ({
  Receiver: vi.fn().mockImplementation(() => ({
    verify: mocks.verify,
  })),
}));

import handler, { dedupeSubscriptionsByEndpoint } from './send-push-for-task.js';

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('QSTASH_CURRENT_SIGNING_KEY', 'current-key');
  vi.stubEnv('QSTASH_NEXT_SIGNING_KEY', 'next-key');
  vi.stubEnv('VAPID_PUBLIC_KEY', 'public-key');
  vi.stubEnv('VAPID_PRIVATE_KEY', 'private-key');
  vi.stubEnv('VAPID_SUBJECT', 'mailto:test@example.com');
  mocks.verify.mockResolvedValue(true);
  mocks.sendNotification.mockResolvedValue({});
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('send-push-for-task reminder delivery', () => {
  it('dedupes enabled push subscriptions by endpoint', () => {
    expect(
      dedupeSubscriptionsByEndpoint([
        { id: 'sub-1', endpoint: 'https://push.example/a' },
        { id: 'sub-2', endpoint: 'https://push.example/a' },
        { id: 'sub-3', endpoint: 'https://push.example/b' },
        { id: 'sub-4', endpoint: '' },
      ]),
    ).toEqual([
      { id: 'sub-1', endpoint: 'https://push.example/a' },
      { id: 'sub-3', endpoint: 'https://push.example/b' },
    ]);
  });

  it('claims the reminder before sending and sends once per unique endpoint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'task-1',
          user_id: 'user-1',
          description: 'Call Loulya',
          status: 'pending',
          type: 'reminder',
          due_at: '2026-06-26T18:49:00.000Z',
          last_push_sent_at: null,
          archived_at: null,
        },
      ]))
      .mockResolvedValueOnce(jsonResponse([
        subscription('sub-1', 'https://push.example/a'),
        subscription('sub-2', 'https://push.example/a'),
        subscription('sub-3', 'https://push.example/b'),
      ]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }]))
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        sent: 2,
        failed: 0,
        markedSent: true,
      }),
    );
    expect(mocks.sendNotification).toHaveBeenCalledTimes(2);

    const claimCall = fetchMock.mock.calls[2];
    expect(String(claimCall[0])).toContain('/rest/v1/tasks');
    expect(String(claimCall[0])).toContain('last_push_sent_at=is.null');
    expect(claimCall[1].method).toBe('PATCH');
    expect(JSON.parse(claimCall[1].body)).toEqual({
      last_push_sent_at: expect.any(String),
    });
  });
});

function createReq(body) {
  return {
    method: 'POST',
    headers: { 'upstash-signature': 'signature' },
    body,
  };
}

function createRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
}

function subscription(id, endpoint) {
  return {
    id,
    endpoint,
    p256dh: `${id}-p256dh`,
    auth: `${id}-auth`,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue({}),
    text: vi.fn().mockResolvedValue(''),
  };
}
