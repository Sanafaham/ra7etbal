import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => ({
  default: {
    sendNotification: vi.fn(),
    setVapidDetails: vi.fn(),
  },
}));

import webpush from 'web-push';
import { processAutomation, processMessageAutomation } from './process-delegation-escalations.js';

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
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
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
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toMatchObject({
      current_state: 'sent',
      sent_at: '2026-06-26T14:30:00.000Z',
    });
    expect(String(fetchMock.mock.calls[5][0])).toContain('/rest/v1/push_subscriptions');
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: 'https://push.example/a', keys: { p256dh: 'p', auth: 'a' } },
      JSON.stringify({
        title: 'Ra7etBal · Reminder',
        body: 'Review your priorities.',
      }),
      { urgency: 'normal', TTL: 600 },
    );
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
  });

  it('keeps owner-only automation successful when owner push fails', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValueOnce(Object.assign(new Error('push rejected'), {
      statusCode: 500,
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1' }], 201))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1' }], 201))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(jsonResponse([
        { id: 'sub-1', endpoint: 'https://push.example/a', p256dh: 'p', auth: 'a' },
      ]))
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
    expect(JSON.parse(fetchMock.mock.calls[4][1].body)).toMatchObject({
      current_state: 'sent',
    });
    expect(JSON.parse(fetchMock.mock.calls[6][1].body)).toMatchObject({
      next_run_at: '2026-06-27T14:30:00.000Z',
    });
    expect(fetchMock.mock.calls.some(([, init]) =>
      String(init?.body ?? '').includes('failure_reason')
    )).toBe(false);
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
