import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendWhatsappTask = vi.hoisted(() => vi.fn());
vi.mock('./send-whatsapp-task.js', () => ({ default: sendWhatsappTask }));

import { persistAndExecuteOwnerCommand } from './_owner-command-executor.js';

const SUPABASE = 'https://example.supabase.co';
const receipt = { receipt_id: '00000000-0000-4000-8000-000000000001', claim_token: 'claim-1' };
const identity = { userId: 'user-1', ownerPhone: '971500000001' };

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
  };
}

function recorded(overrides = {}) {
  return {
    id: receipt.receipt_id,
    retry_count: 1,
    max_retries: 5,
    acknowledgement_status: 'pending',
    execution_result: {},
    action_task_id: null,
    action_message_id: null,
    staff_transport_message_id: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  process.env.QSTASH_TOKEN = 'qstash-token';
  process.env.CRON_SECRET = 'cron-secret';
  process.env.APP_BASE_URL = 'https://www.ra7etbal.com';
  sendWhatsappTask.mockReset();
  sendWhatsappTask.mockImplementation(async (_req, res) =>
    res.status(200).json({ success: true, messageId: 'wamid.staff-1' }));
});

describe('owner command execution boundary', () => {
  it('persists timezone-aware due_at before scheduling one reminder push', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T15:59:40.000Z'));
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) return response(recorded());
      if (target.includes('/profiles?') && target.includes('display_name')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/profiles?') && target.includes('morning_brief_timezone')) {
        return response([{ morning_brief_timezone: 'Europe/Istanbul' }]);
      }
      if (target.endsWith('/rest/v1/tasks') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return response([{
          ...body,
          due_at: body.due_at.replace('T', ' ').replace('.000Z', '+00'),
          created_at: '2026-07-28T00:00:00.000Z',
          qstash_message_id: null,
        }]);
      }
      if (target.startsWith('https://qstash.upstash.io/')) return response({ messageId: 'qstash-1' });
      if (target.includes('/rest/v1/tasks?id=eq.') && options.method === 'PATCH') return response({});
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') {
        return response([recorded()]);
      }
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: {
        body: 'Remind me at 7:03 PM today to check the owner WhatsApp acknowledgement.',
        phoneNumberId: 'phone-1',
      },
    });

    expect(result.kind).toBe('completed');
    const taskCreate = calls.find((call) =>
      call.url.endsWith('/rest/v1/tasks') && call.options.method === 'POST');
    expect(JSON.parse(taskCreate.options.body)).toMatchObject({
      description: 'check the owner WhatsApp acknowledgement',
      due_at: '2026-07-28T16:03:00.000Z',
      status: 'pending',
      type: 'reminder',
    });
    const taskCreateIndex = calls.indexOf(taskCreate);
    const qstashIndex = calls.findIndex((call) => call.url.startsWith('https://qstash.upstash.io/'));
    expect(taskCreateIndex).toBeLessThan(qstashIndex);
    expect(calls.filter((call) =>
      call.url.endsWith('/rest/v1/tasks') && call.options.method === 'POST')).toHaveLength(1);
    expect(calls.filter((call) => call.url.startsWith('https://qstash.upstash.io/'))).toHaveLength(1);
    expect(result.acknowledgement)
      .toBe('Done — I created one reminder for Tuesday, 7:03 PM.');
    vi.useRealTimers();
  });

  it('retries the failed action without resending an already accepted failure acknowledgement', async () => {
    const acknowledgement =
      'I recorded your command, but I could not complete it. Nothing further was claimed as done; Ra7etBal will retry it safely.';
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) {
        return response(recorded({
          acknowledgement_status: 'accepted',
          acknowledgement_text: acknowledgement,
          acknowledgement_transport_message_id: 'wamid.original-ack',
        }));
      }
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) return response([]);
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') {
        return response([recorded()]);
      }
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to clean the kitchen.', phoneNumberId: 'phone-1' },
    });

    expect(result).toMatchObject({
      kind: 'execution_failed',
      acknowledgement,
      acknowledgementAlreadyAccepted: true,
    });
    expect(calls.filter((call) => call.url.includes('/people?'))).toHaveLength(1);
    expect(calls.some((call) => {
      if (!call.url.includes('/owner_whatsapp_reply_receipts?') || call.options.method !== 'PATCH') {
        return false;
      }
      return Object.hasOwn(JSON.parse(call.options.body), 'acknowledgement_transport_message_id');
    })).toBe(false);
  });

  it('reminder parsing failure creates nothing and truthfully says nothing was scheduled', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) return response(recorded());
      if (target.includes('/profiles?') && target.includes('display_name')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/profiles?') && target.includes('morning_brief_timezone')) {
        return response([{ morning_brief_timezone: 'Invalid/Timezone' }]);
      }
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') {
        return response([recorded()]);
      }
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Remind me tomorrow at 5:30 PM.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).toBe('terminal_failed');
    expect(result.acknowledgement).toContain('nothing was scheduled');
    expect(calls.some((call) =>
      call.url.endsWith('/rest/v1/tasks') && call.options.method === 'POST')).toBe(false);
    expect(calls.some((call) => call.url.startsWith('https://qstash.upstash.io/'))).toBe(false);
  });

  it('delegation creates one deterministic task/message, schedules escalation once, and sends once', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) return response(recorded());
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) {
        return response([{ id: 'person-1', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true }]);
      }
      if (target.endsWith('/rest/v1/tasks') && options.method === 'POST') {
        const body = JSON.parse(options.body);
        return response([{ ...body, created_at: '2026-07-28T00:00:00.000Z' }]);
      }
      if (target.startsWith('https://qstash.upstash.io/')) return response({ messageId: `qstash-${calls.length}` });
      if (target.endsWith('/rest/v1/messages') && options.method === 'POST') return response([JSON.parse(options.body)]);
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') return response([recorded()]);
      if (target.includes('/whatsapp_deliveries?')) return response([]);
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to confirm the guest room is ready.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).toBe('completed');
    expect(sendWhatsappTask).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.url.startsWith('https://qstash.upstash.io/'))).toHaveLength(2);
    const taskBody = JSON.parse(calls.find((call) =>
      call.url.endsWith('/rest/v1/tasks') && call.options.method === 'POST').options.body);
    const messageBody = JSON.parse(calls.find((call) =>
      call.url.endsWith('/rest/v1/messages') && call.options.method === 'POST').options.body);
    expect(taskBody.id).toBe(receipt.receipt_id);
    expect(messageBody.id).toBe(receipt.receipt_id);
    expect(taskBody.confirmation_url).toContain(receipt.receipt_id);
  });

  it('direct message creates no task/link and schedules neither reminder nor escalation', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), options });
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) return response(recorded());
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) {
        return response([{ id: 'person-1', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true }]);
      }
      if (target.endsWith('/rest/v1/messages') && options.method === 'POST') return response([JSON.parse(options.body)]);
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') return response([recorded()]);
      if (target.includes('/whatsapp_deliveries?')) return response([]);
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to call myself.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).toBe('completed');
    expect(calls.some((call) => call.url.endsWith('/rest/v1/tasks'))).toBe(false);
    expect(calls.some((call) => call.url.startsWith('https://qstash.upstash.io/'))).toBe(false);
    expect(sendWhatsappTask).toHaveBeenCalledTimes(1);
    expect(sendWhatsappTask.mock.calls[0][0].body).toMatchObject({
      messageText: 'call Sana.',
      confirmationLink: null,
      taskId: null,
    });
  });

  it('an accepted staff send is not resent during command retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) {
        return response(recorded({ staff_transport_message_id: 'wamid.accepted-1' }));
      }
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) {
        return response([{ id: 'person-1', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true }]);
      }
      if (target.endsWith('/rest/v1/messages') && options.method === 'POST') return response([]);
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') return response([recorded()]);
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to call me.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).toBe('completed');
    expect(sendWhatsappTask).not.toHaveBeenCalled();
  });

  it('a retry after task creation uses the deterministic task id and duplicate-safe insert', async () => {
    const taskPosts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) {
        return response(recorded({
          action_task_id: receipt.receipt_id,
          execution_result: { command_type: 'delegation', escalation_scheduled: true },
          staff_transport_message_id: 'wamid.accepted-1',
        }));
      }
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) {
        return response([{ id: 'person-1', name: 'Grace', phone: '+971500000002', whatsapp_opted_in: true }]);
      }
      if (target.endsWith('/rest/v1/tasks') && options.method === 'POST') {
        taskPosts.push({ headers: options.headers, body: JSON.parse(options.body) });
        return response([]);
      }
      if (target.includes('/rest/v1/tasks?')) {
        return response([{ id: receipt.receipt_id, created_at: '2026-07-28T00:00:00.000Z' }]);
      }
      if (target.endsWith('/rest/v1/messages') && options.method === 'POST') return response([]);
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') return response([recorded()]);
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to clean the kitchen.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).toBe('completed');
    expect(taskPosts).toHaveLength(1);
    expect(taskPosts[0].body.id).toBe(receipt.receipt_id);
    expect(taskPosts[0].headers.Prefer).toContain('resolution=ignore-duplicates');
    expect(sendWhatsappTask).not.toHaveBeenCalled();
  });

  it('retry exhaustion persists terminal_failed and never promises another retry', async () => {
    const updates = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const target = String(url);
      if (target.includes('/rpc/record_owner_whatsapp_command')) {
        return response(recorded({ retry_count: 5, max_retries: 5 }));
      }
      if (target.includes('/profiles?')) return response([{ display_name: 'Sana' }]);
      if (target.includes('/people?')) return response([]);
      if (target.includes('/owner_whatsapp_reply_receipts?') && options.method === 'PATCH') {
        updates.push(JSON.parse(options.body));
        return response([recorded()]);
      }
      throw new Error(`unexpected fetch ${target}`);
    }));

    const result = await persistAndExecuteOwnerCommand({
      supabaseUrl: SUPABASE,
      serviceKey: 'service-key',
      identity,
      receipt,
      msg: { body: 'Ask Grace to clean the kitchen.', phoneNumberId: 'phone-1' },
    });

    expect(result.kind).toBe('terminal_failed');
    expect(result.acknowledgement).toContain('no further retry is scheduled');
    expect(updates).toContainEqual(expect.objectContaining({
      execution_status: 'terminal_failed',
      next_retry_at: null,
    }));
  });
});
