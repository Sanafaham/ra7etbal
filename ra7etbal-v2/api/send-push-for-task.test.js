import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  verify: vi.fn(),
  deliverOwnerReminderWhatsapp: vi.fn(),
  getOrCreateOwnerNotification: vi.fn(),
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

vi.mock('./_owner-reminder-whatsapp.js', () => ({
  deliverOwnerReminderWhatsapp: mocks.deliverOwnerReminderWhatsapp,
}));

vi.mock('./_owner-notifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getOrCreateOwnerNotification: mocks.getOrCreateOwnerNotification,
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
  vi.stubEnv('CRON_SECRET', 'receipt-secret');
  mocks.verify.mockResolvedValue(true);
  mocks.sendNotification.mockResolvedValue({});
  mocks.deliverOwnerReminderWhatsapp.mockResolvedValue({
    attempted: true,
    status: 'accepted',
    deliveryId: 'owner-reminder-delivery-1',
  });
  mocks.getOrCreateOwnerNotification.mockResolvedValue({
    created: true,
    notification: {
      id: 'notification-1',
      title: 'Ra7etBal',
      body: 'Call Loulya',
      target_url: '/updates?tab=todo',
    },
  });
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

  it('records provider acceptance without falsely completing the reminder', async () => {
    const patches = [];
    const events = [];
    const fetchMock = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/rest/v1/tasks?select=')) return jsonResponse([
        {
          id: 'task-1',
          user_id: 'user-1',
          description: 'Call Loulya',
          status: 'pending',
          type: 'reminder',
          due_at: '2026-06-26T18:49:00.000Z',
          last_push_sent_at: null,
          archived_at: null,
          reminder_delivery_status: 'scheduled',
        },
      ]);
      if (value.includes('/rest/v1/push_subscriptions')) return jsonResponse([
        subscription('sub-1', 'https://push.example/a'),
        subscription('sub-2', 'https://push.example/a'),
        subscription('sub-3', 'https://push.example/b'),
      ]);
      if (value.includes('/rest/v1/reminder_delivery_events')) {
        events.push(JSON.parse(options.body));
        return emptyResponse();
      }
      if (value.includes('/rest/v1/tasks') && options.method === 'PATCH') {
        const body = JSON.parse(options.body);
        patches.push(body);
        return options.headers.Prefer === 'return=representation'
          ? jsonResponse([{ id: 'task-1' }])
          : emptyResponse();
      }
      throw new Error(`Unexpected fetch: ${value}`);
    });
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
    expect(mocks.deliverOwnerReminderWhatsapp).toHaveBeenCalledTimes(1);
    expect(mocks.getOrCreateOwnerNotification).toHaveBeenCalledTimes(1);

    expect(patches[0]).toEqual({
      reminder_delivery_status: 'dispatch_attempted',
      reminder_dispatch_attempted_at: expect.any(String),
    });
    expect(patches[1]).toEqual(expect.objectContaining({
      last_push_sent_at: expect.any(String),
      reminder_delivery_status: 'delivery_unconfirmed',
      reminder_provider_accepted_at: expect.any(String),
    }));
    expect(patches.flatMap(Object.keys)).not.toContain('status');
    expect(patches.flatMap(Object.keys)).not.toContain('confirmed_at');
    expect(events.filter((event) => event.stage === 'provider_accepted')).toHaveLength(2);
    const payload = JSON.parse(mocks.sendNotification.mock.calls[0][1]);
    expect(payload.receipt).toEqual(expect.objectContaining({
      taskId: 'task-1',
      subscriptionId: 'sub-1',
      dueAt: '2026-06-26T18:49:00.000Z',
      token: expect.any(String),
    }));
    expect(payload).toEqual(expect.objectContaining({
      title: 'Ra7etBal',
      body: 'Call Loulya',
      notificationId: 'notification-1',
      url: '/updates?tab=todo',
    }));
  });

  it('creates the durable inbox event even when the owner has no push subscription', async () => {
    const fetchMock = successfulReminderFetch();
    fetchMock.mockImplementationOnce(async () => jsonResponse([{
      id: 'task-1', user_id: 'user-1', description: 'Call Loulya',
      status: 'pending', type: 'reminder', due_at: '2026-06-26T18:49:00.000Z',
      last_push_sent_at: null, archived_at: null, reminder_delivery_status: 'scheduled',
    }]));
    fetchMock.mockImplementationOnce(async () => jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(mocks.getOrCreateOwnerNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'No enabled push subscriptions.',
    }));
  });

  it('does not create a historical inbox row for an already-sent retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/rest/v1/tasks?select=')) return jsonResponse([{
        id: 'task-1', user_id: 'user-1', description: 'Call Loulya',
        status: 'pending', type: 'reminder', due_at: '2026-06-26T18:49:00.000Z',
        last_push_sent_at: '2026-06-26T18:49:02.000Z', archived_at: null,
        reminder_delivery_status: 'delivery_unconfirmed',
      }]);
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(mocks.deliverOwnerReminderWhatsapp).toHaveBeenCalledTimes(1);
    expect(mocks.getOrCreateOwnerNotification).not.toHaveBeenCalled();
    expect(mocks.sendNotification).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Push already sent.' }));
  });

  it('keeps push truthful when owner WhatsApp fails synchronously', async () => {
    mocks.deliverOwnerReminderWhatsapp.mockResolvedValue({
      attempted: true,
      status: 'failed',
      deliveryId: 'owner-reminder-delivery-1',
      reason: 'Meta rejected owner reminder.',
    });
    vi.stubGlobal('fetch', successfulReminderFetch());

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      sent: 1,
      markedSent: true,
      whatsapp: expect.objectContaining({ status: 'failed' }),
    }));
  });

  it('preserves accepted WhatsApp evidence when push fails', async () => {
    const pushError = new Error('Push provider unavailable');
    pushError.statusCode = 503;
    mocks.sendNotification.mockRejectedValue(pushError);
    vi.stubGlobal('fetch', successfulReminderFetch());

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      sent: 0,
      failed: 1,
      whatsapp: expect.objectContaining({ status: 'accepted' }),
    }));
  });

  it('does not block or duplicate the working push when inbox persistence fails', async () => {
    mocks.getOrCreateOwnerNotification.mockRejectedValueOnce(new Error('inbox unavailable'));
    vi.stubGlobal('fetch', successfulReminderFetch());

    const res = createRes();
    await handler(createReq({ taskId: 'task-1' }), res);

    expect(mocks.getOrCreateOwnerNotification).toHaveBeenCalledTimes(1);
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mocks.sendNotification.mock.calls[0][1])).not.toHaveProperty('notificationId');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, sent: 1 }));
  });
});

function successfulReminderFetch() {
  return vi.fn(async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/rest/v1/tasks?select=')) return jsonResponse([{
      id: 'task-1', user_id: 'user-1', description: 'Call Loulya',
      status: 'pending', type: 'reminder', due_at: '2026-06-26T18:49:00.000Z',
      last_push_sent_at: null, archived_at: null, reminder_delivery_status: 'scheduled',
    }]);
    if (value.includes('/rest/v1/push_subscriptions')) return jsonResponse([
      subscription('sub-1', 'https://push.example/a'),
    ]);
    if (value.includes('/rest/v1/reminder_delivery_events')) return emptyResponse();
    if (value.includes('/rest/v1/tasks') && options.method === 'PATCH') {
      return options.headers.Prefer === 'return=representation'
        ? jsonResponse([{ id: 'task-1' }])
        : emptyResponse();
    }
    throw new Error(`Unexpected fetch: ${value}`);
  });
}

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
