import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    sendNotification: vi.fn(),
    setVapidDetails: vi.fn(),
  },
}));

import webpush from 'web-push';
import {
  processAutomation,
  processMessageAutomation,
  runAutomationsCore,
  computeNextRunAt,
} from './process-delegation-escalations.js';

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', 'cron-secret');
  vi.mocked(webpush.sendNotification).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('processMessageAutomation', () => {
  it('sends recurring message automations without creating a task or confirmation link', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Sana', phone: '+971500000000' }]))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        messageId: 'wamid.automation',
        delivery_id: 'delivery-1',
      }))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processMessageAutomation({
      automation: automationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      runId: 'run-1',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/v1/people');

    expect(fetchMock.mock.calls[1][0]).toBe('https://ra7etbal.com/api/send-whatsapp-task');
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({
      'Content-Type': 'application/json',
      'x-ra7etbal-internal-secret': 'cron-secret',
      Authorization: 'Bearer cron-secret',
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      to: '+971500000000',
      messageText: 'Recurring automation test.',
      automationRunId: 'run-1',
      sourceType: 'automation_message',
      sendMode: 'routine_message',
      recipientName: 'Sana',
    });

    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      current_state: 'sent',
      sent_at: '2026-06-26T14:30:00.000Z',
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/tasks'))).toBe(false);
    expect(fetchMock.mock.calls.some(([, init]) => String(init?.body ?? '').includes('confirmationLink'))).toBe(false);
  });

  it('returns failed and stores the WhatsApp failure reason when the send is rejected', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Sana', phone: '+971500000000' }]))
      .mockResolvedValueOnce(jsonResponse(
        { success: false, errorMessage: 'Meta rejected the routine template.', delivery_id: 'delivery-1' },
        400,
      ))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processMessageAutomation({
      automation: automationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      runId: 'run-1',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('failed');
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      current_state: 'failed',
      failure_reason: 'WhatsApp send failed (400): Meta rejected the routine template.',
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });
});

describe('processAutomation owner-only automations', () => {
  it('creates an owner task and sends an owner push', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/rest/v1/tasks');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      user_id: 'user-1',
      type: 'action',
      description: 'Review your priorities.',
      status: 'pending',
      needs_follow_up: false,
      assigned_to: null,
      due_at: '2026-06-26T14:30:00.000Z',
    });
    expect(String(fetchMock.mock.calls[4][0])).toContain('/rest/v1/push_subscriptions');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } },
      JSON.stringify({
        title: 'Ra7etBal · Reminder',
        body: 'Review your priorities.',
      }),
      { urgency: 'normal', TTL: 600 },
    );
    // current_state is only recorded 'sent' AFTER the push attempt resolves.
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toMatchObject({
      current_state: 'sent',
      sent_at: '2026-06-26T14:30:00.000Z',
    });
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });

  // Regression: this test previously asserted the OPPOSITE — that a failed
  // owner push was still reported as a successful ('sent') run, on the theory
  // that task creation alone counted as success. That was a truthfulness bug:
  // for an owner-only reminder, the push IS the delivery (there is no WhatsApp
  // leg), so reporting 'sent' when nothing was actually delivered is a false
  // success. Corrected so current_state accurately reflects delivery.
  it('marks owner-only automation failed (not sent) when owner push fails', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(Object.assign(new Error('push rejected'), {
      statusCode: 500,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toMatchObject({
      current_state: 'failed',
      failure_reason: 'Owner push notification was not delivered (no enabled subscription or every send failed).',
    });
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).not.toHaveProperty('sent_at');
    // The cycle is still spent — next_run_at must still advance so the
    // automation isn't permanently stuck on a delivery failure.
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });

  // Required test: "Missing owner notification destination fails truthfully."
  it('marks owner-only automation failed when the owner has no enabled push subscription at all', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([])) // zero push_subscriptions rows
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(JSON.parse(fetchMock.mock.calls[5][1].body)).toMatchObject({
      current_state: 'failed',
    });
  });

  // Required test: "Owner and household scoping" — the push query and task
  // row must be scoped to the automation's own user_id only.
  it('scopes the owner task and push lookup to the automation owner only', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    await processAutomation({
      automation: ownerOnlyAutomationRow({ user_id: 'user-owner-42' }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({ user_id: 'user-owner-42' });
    expect(String(fetchMock.mock.calls[4][0])).toContain('user_id=eq.user-owner-42');
  });

  // Required test: "Retry does not duplicate a completed execution" /
  // "Concurrent runners do not duplicate execution." The unique(automation_id,
  // run_for) constraint + Prefer: resolution=ignore-duplicates on the
  // automation_run insert is the actual lock — PostgREST returns [] when a
  // run for this cycle already exists, whether from a true concurrent
  // invocation or a retried cron tick.
  it('skips and never sends a push when this cycle already has an automation_run (duplicate/concurrent invocation)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([], 200)) // ignore-duplicates conflict → empty array
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow(),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/tasks'))).toBe(false);
    // Still advances next_run_at so a stale run_for can't block every future tick.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });
});

describe('processAutomation — invalid recurrence fails safely', () => {
  // Required test: "Invalid recurrence fails safely." A malformed
  // cadence_value (e.g. every_n_days missing n) must pause the automation
  // with a clear reason instead of crashing or silently rescheduling.
  it('pauses the automation with a clear reason when cadence_value is invalid, after still delivering the current cycle', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow({
        cadence_type: 'every_n_days',
        cadence_value: { time: '09:00' }, // missing required "n"
      }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-26T14:30:00.000Z'),
    });

    expect(result).toBe('ok');
    // The final call pauses the automation instead of setting next_run_at.
    const lastCallBody = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
    expect(lastCallBody).toMatchObject({ status: 'paused' });
    expect(lastCallBody.paused_reason).toMatch(/Invalid cadence_value/);
    expect(lastCallBody).not.toHaveProperty('next_run_at');
  });
});

describe('runAutomationsCore — due-automation query scoping', () => {
  // Required tests: "Inactive automation does not execute" / "Future
  // automation does not execute early." The runner relies entirely on the
  // PostgREST filter to exclude both — this locks in that the filter is
  // actually present in the query, so a future edit can't silently drop it.
  it('queries only active automations whose next_run_at has passed', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    await runAutomationsCore({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
    });

    const queriedUrl = String(fetchMock.mock.calls[0][0]);
    expect(queriedUrl).toContain('/rest/v1/automations');
    expect(queriedUrl).toContain('status=eq.active');
    expect(queriedUrl).toMatch(/next_run_at=lte\./);
  });

  it('processes each due automation independently — one failure does not stop the others', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        ownerOnlyAutomationRow({ id: 'automation-fail' }),
        ownerOnlyAutomationRow({ id: 'automation-ok' }),
      ]))
      // automation-fail: automation_run insert itself fails
      .mockResolvedValueOnce(jsonResponse({ message: 'db error' }, 500))
      // automation-ok: full successful owner-push cycle
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-2' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-2' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const stats = await runAutomationsCore({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
    });

    expect(stats).toMatchObject({ checked: 2, fired: 1, failed: 1 });
  });
});

describe('computeNextRunAt — recurrence, local time, and timezone/DST correctness', () => {
  it('advances daily cadence by exactly one calendar day in a non-DST timezone (Europe/Istanbul)', () => {
    const next = computeNextRunAt({
      cadence_type: 'daily',
      cadence_value: { time: '09:00' },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z', // 09:00 local
    });
    expect(next).toBe('2026-06-22T06:00:00.000Z'); // still 09:00 local, +24h UTC
  });

  it('preserves the local wall-clock time across a spring-forward DST transition (America/New_York)', () => {
    // 2026-03-08 is the US spring-forward date (clocks jump 2:00am -> 3:00am).
    const next = computeNextRunAt({
      cadence_type: 'daily',
      cadence_value: { time: '09:00' },
      timezone: 'America/New_York',
      next_run_at: '2026-03-07T14:00:00.000Z', // 09:00 EST (UTC-5)
    });
    // 09:00 EDT (UTC-4) the next day — only +23h in UTC terms, not +24h.
    expect(next).toBe('2026-03-08T13:00:00.000Z');
  });

  it('preserves the local wall-clock time across a fall-back DST transition (America/New_York)', () => {
    // 2026-11-01 is the US fall-back date (clocks repeat 1:00am-2:00am).
    const next = computeNextRunAt({
      cadence_type: 'daily',
      cadence_value: { time: '09:00' },
      timezone: 'America/New_York',
      next_run_at: '2026-10-31T13:00:00.000Z', // 09:00 EDT (UTC-4)
    });
    // 09:00 EST (UTC-5) the next day — +25h in UTC terms, not +24h.
    expect(next).toBe('2026-11-01T14:00:00.000Z');
  });

  it('advances weekly cadence by 7 local days', () => {
    const next = computeNextRunAt({
      cadence_type: 'weekly',
      cadence_value: { time: '09:00', day: 1 },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-22T06:00:00.000Z',
    });
    expect(next).toBe('2026-06-29T06:00:00.000Z');
  });

  it('advances every_n_days cadence by the configured interval', () => {
    const next = computeNextRunAt({
      cadence_type: 'every_n_days',
      cadence_value: { time: '09:00', n: 3 },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z',
    });
    expect(next).toBe('2026-06-24T06:00:00.000Z');
  });

  it('returns null for cadence_type=once (caller stops the automation instead of rescheduling)', () => {
    expect(computeNextRunAt({ cadence_type: 'once', cadence_value: {}, timezone: 'Europe/Istanbul', next_run_at: '2026-06-21T06:00:00.000Z' })).toBeNull();
  });

  it('returns "invalid" for every_n_days with a missing/non-integer n, so the caller pauses instead of crashing', () => {
    expect(computeNextRunAt({
      cadence_type: 'every_n_days',
      cadence_value: { time: '09:00' },
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z',
    })).toBe('invalid');
  });

  it('returns "invalid" for an unrecognised cadence_type', () => {
    expect(computeNextRunAt({
      cadence_type: 'bogus',
      cadence_value: {},
      timezone: 'Europe/Istanbul',
      next_run_at: '2026-06-21T06:00:00.000Z',
    })).toBe('invalid');
  });
});

describe('processAutomation unsupported recurring WhatsApp automations', () => {
  it('skips and pauses delegated recurring automations before creating tasks or WhatsApp deliveries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: ownerOnlyAutomationRow({
        title: 'Weekly Flower Inventory',
        instruction: 'Send the flower inventory.',
        assignee_id: 'person-grace',
        cadence_type: 'weekly',
      }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-29T07:00:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      current_state: 'skipped',
      failure_reason: 'Recurring WhatsApp automations are currently disabled; no task or WhatsApp message was created.',
    });
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({
      status: 'paused',
      paused_reason: 'Recurring WhatsApp automations are currently disabled; no task or WhatsApp message was created.',
      updated_at: '2026-06-29T07:00:00.000Z',
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/tasks'))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    // Required: "Never execute staff routines through an owner-reminder path."
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/push_subscriptions'))).toBe(false);
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('skips and pauses recurring message automations before sending WhatsApp', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await processAutomation({
      automation: automationRow({ automation_type: 'message', cadence_type: 'daily' }),
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      appBaseUrl: 'https://ra7etbal.com',
      now: new Date('2026-06-29T07:00:00.000Z'),
    });

    expect(result).toBe('skipped');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/send-whatsapp-task'))).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toMatchObject({ status: 'paused' });
  });
});

function automationRow(overrides = {}) {
  return {
    id: 'automation-1',
    user_id: 'user-1',
    title: 'Recurring automation test',
    instruction: 'Recurring automation test.',
    automation_type: 'message',
    assignee_id: 'person-1',
    cadence_type: 'daily',
    cadence_value: { time: '17:30' },
    timezone: 'Europe/Istanbul',
    next_run_at: '2026-06-26T14:30:00.000Z',
    ...overrides,
  };
}

function ownerOnlyAutomationRow(overrides = {}) {
  return {
    id: 'automation-1',
    user_id: 'user-1',
    title: 'Daily priorities',
    instruction: 'Review your priorities.',
    automation_type: 'delegation',
    assignee_id: null,
    cadence_type: 'daily',
    cadence_value: { time: '17:30' },
    timezone: 'Europe/Istanbul',
    next_run_at: '2026-06-26T14:30:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function emptyResponse(status = 204) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => null,
    text: async () => '',
  };
}
