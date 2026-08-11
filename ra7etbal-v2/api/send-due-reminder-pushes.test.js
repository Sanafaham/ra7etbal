import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  deliverOwnerReminderWhatsapp: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: mocks.sendNotification,
  },
}));

vi.mock('./_owner-reminder-whatsapp.js', () => ({
  deliverOwnerReminderWhatsapp: mocks.deliverOwnerReminderWhatsapp,
}));

import {
  SAFETY_NET_TASK_SELECT,
  compareAuthorizationToCronSecret,
  getUnauthorizedCallerDiagnostic,
  default as handler,
} from './send-due-reminder-pushes.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('send-due-reminder-pushes authorization diagnostics', () => {
  it('redacts unauthorized caller auth while preserving scheduler-identifying headers', () => {
    expect(
      getUnauthorizedCallerDiagnostic({
        method: 'POST',
        url: '/api/send-due-reminder-pushes',
        headers: {
          authorization: 'Bearer secret-value',
          host: 'ra7etbal-v2.vercel.app',
          'user-agent': 'Upstash-QStash',
          'upstash-schedule-id': 'schedule-1',
          'upstash-signature': 'signature-value',
          'x-vercel-id': 'iad1::abc',
        },
      }),
    ).toEqual({
      method: 'POST',
      url: '/api/send-due-reminder-pushes',
      host: 'ra7etbal-v2.vercel.app',
      userAgent: 'Upstash-QStash',
      hasAuthorization: true,
      authorizationScheme: 'Bearer',
      authComparison: {
        hasExpectedSecret: false,
        exactMatch: false,
        tokenLength: 12,
        expectedSecretLength: 0,
        tokenHasLeadingOrTrailingWhitespace: false,
        expectedSecretHasLeadingOrTrailingWhitespace: false,
        tokenTrimMatchesExpected: false,
        tokenMatchesExpectedTrim: false,
        tokenTrimMatchesExpectedTrim: false,
      },
      qstashHeaders: ['upstash-schedule-id', 'upstash-signature'],
      vercelId: 'iad1::abc',
    });
  });

  it('reports whether an unauthorized bearer token only differs by whitespace', () => {
    process.env.CRON_SECRET = 'cron-secret';

    expect(compareAuthorizationToCronSecret('Bearer cron-secret\n')).toEqual({
      hasExpectedSecret: true,
      exactMatch: false,
      tokenLength: 12,
      expectedSecretLength: 11,
      tokenHasLeadingOrTrailingWhitespace: true,
      expectedSecretHasLeadingOrTrailingWhitespace: false,
      tokenTrimMatchesExpected: true,
      tokenMatchesExpectedTrim: false,
      tokenTrimMatchesExpectedTrim: true,
    });
  });

  it('keeps the safety-net push and owner WhatsApp channels independent', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
    vi.stubEnv('VAPID_PUBLIC_KEY', 'public-key');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'private-key');
    vi.stubEnv('VAPID_SUBJECT', 'mailto:test@example.com');
    vi.stubEnv('CRON_SECRET', 'cron-secret');
    mocks.sendNotification.mockResolvedValue({ statusCode: 201 });
    mocks.deliverOwnerReminderWhatsapp.mockResolvedValue({
      attempted: true,
      status: 'accepted',
      deliveryId: 'delivery-1',
    });

    const fetchMock = vi.fn(async (url, options = {}) => {
      const value = String(url);
      if (value.includes('/rest/v1/tasks?select=')) {
        return jsonResponse([projectSelectedTaskFields(value, {
          id: 'task-1', user_id: 'user-1', description: 'Check the bill',
          type: 'reminder', status: 'pending', due_at: '2026-08-11T16:03:00.000Z',
          last_push_sent_at: null, reminder_delivery_status: 'scheduled',
        })]);
      }
      if (value.includes('/rest/v1/push_subscriptions')) return jsonResponse([{
        id: 'sub-1', user_id: 'user-1', endpoint: 'https://push.example/one',
        p256dh: 'p256dh', auth: 'auth',
      }]);
      if (value.includes('/rest/v1/reminder_delivery_events')) return emptyResponse();
      if (value.includes('/rest/v1/tasks') && options.method === 'PATCH') {
        return options.headers.Prefer === 'return=representation'
          ? jsonResponse([{ id: 'task-1' }])
          : emptyResponse();
      }
      throw new Error(`Unexpected fetch: ${value}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler({ method: 'POST', query: { test: '1' }, headers: {}, url: '?test=1' }, res);

    expect(mocks.deliverOwnerReminderWhatsapp).toHaveBeenCalledTimes(1);
    expect(SAFETY_NET_TASK_SELECT.split(',')).toContain('type');
    expect(mocks.deliverOwnerReminderWhatsapp).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ type: 'reminder' }),
    }));
    expect(mocks.sendNotification).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      pushSuccessCount: 1,
      markedSent: 1,
      whatsapp: { attempted: 1, accepted: 1, failed: 0, skipped: 0 },
    }));
  });
});

function projectSelectedTaskFields(url, row) {
  const selectedFields = new URL(url).searchParams.get('select').split(',');
  return Object.fromEntries(selectedFields.map((field) => [field, row[field]]));
}

function createRes() {
  const res = {
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  return res;
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
  return jsonResponse({}, status);
}
