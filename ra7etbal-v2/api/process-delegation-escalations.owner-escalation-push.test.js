import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() },
}));

const ownerNotificationMocks = vi.hoisted(() => ({
  prepareOwnerPushNotification: vi.fn(async ({ fallback }) => fallback),
}));
vi.mock('./_owner-notifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareOwnerPushNotification: ownerNotificationMocks.prepareOwnerPushNotification,
}));

import webpush from 'web-push';
import { escalationTargetUrl, sendOwnerEscalationPush } from './process-delegation-escalations.js';

const TASK = {
  id: '335ef5db-e710-4ce9-a35f-71907f97d06e',
  user_id: 'owner-1',
  assigned_to: 'Christopher',
  description: 'Buy salmon for dinner',
};
const SUBS = [
  { id: 'sub-iphone', endpoint: 'https://web.push.apple.com/a', p256dh: 'p', auth: 'a' },
  { id: 'sub-mac', endpoint: 'https://fcm.googleapis.com/b', p256dh: 'p', auth: 'a' },
];

function stubFetch() {
  const fetchMock = vi.fn(async (url) => {
    if (String(url).includes('/rest/v1/push_subscriptions')) {
      return new Response(JSON.stringify(SUBS), { status: 200 });
    }
    return new Response(null, { status: 201 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const evidenceRows = (fetchMock) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url).includes('/rest/v1/reminder_delivery_events'))
    .map(([, init]) => JSON.parse(init.body));

beforeEach(() => {
  vi.mocked(webpush.sendNotification).mockReset();
  ownerNotificationMocks.prepareOwnerPushNotification.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('owner escalation push (PR #458 salmon incident)', () => {
  it('links the escalation to Waiting, where an unanswered delegation actually is', async () => {
    stubFetch();
    vi.mocked(webpush.sendNotification).mockResolvedValue({ statusCode: 201 });
    await sendOwnerEscalationPush({ task: TASK, supabaseUrl: 'https://db', serviceKey: 'k', testMode: false });

    const { notification } = ownerNotificationMocks.prepareOwnerPushNotification.mock.calls[0][0];
    expect(notification.targetUrl).toBe(`/updates?tab=waiting&task=${TASK.id}`);
    expect(notification.targetUrl).toBe(escalationTargetUrl(TASK.id));
    expect(notification.kind).toBe('task_escalation');
    expect(notification.eventKey).toBe(`task_escalation:${TASK.id}`);
  });

  it('records provider evidence per device so a missing banner can be diagnosed', async () => {
    const fetchMock = stubFetch();
    vi.mocked(webpush.sendNotification)
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));

    const sent = await sendOwnerEscalationPush({ task: TASK, supabaseUrl: 'https://db', serviceKey: 'k', testMode: false });

    expect(sent).toBe(true);
    const rows = evidenceRows(fetchMock);
    expect(rows.map((r) => [r.subscription_id, r.stage])).toEqual([
      ['sub-iphone', 'provider_send_attempted'],
      ['sub-iphone', 'provider_accepted'],
      ['sub-mac', 'provider_send_attempted'],
      ['sub-mac', 'provider_rejected'],
    ]);
    expect(rows.every((r) => r.task_id === TASK.id && r.user_id === 'owner-1')).toBe(true);
    expect(rows.every((r) => r.metadata.kind === 'escalation_push')).toBe(true);
    expect(rows[3]).toMatchObject({ provider_status_code: 410, metadata: { permanent: true } });
    expect(new Set(rows.map((r) => r.event_key)).size).toBe(4);
    // Stale subscription cleanup is unchanged.
    expect(fetchMock.mock.calls.some(([url, init]) =>
      String(url).includes('push_subscriptions?id=eq.sub-mac') && init?.method === 'DELETE')).toBe(true);
  });

  it('still sends the push when recording evidence fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).includes('/rest/v1/push_subscriptions')) {
        return new Response(JSON.stringify([SUBS[0]]), { status: 200 });
      }
      return new Response('boom', { status: 500 });
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(webpush.sendNotification).mockResolvedValue({ statusCode: 201 });

    const sent = await sendOwnerEscalationPush({ task: TASK, supabaseUrl: 'https://db', serviceKey: 'k', testMode: false });
    expect(sent).toBe(true);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });

  it('sends nothing and records nothing when the owner has no subscriptions', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const sent = await sendOwnerEscalationPush({ task: TASK, supabaseUrl: 'https://db', serviceKey: 'k', testMode: false });
    expect(sent).toBe(false);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(evidenceRows(fetchMock)).toEqual([]);
  });
});
