import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deliverOwnerReminderWhatsapp,
  formatOwnerReminderMessage,
} from './_owner-reminder-whatsapp.js';
import { buildRoutineMessagePayload } from './send-whatsapp-task.js';

const TASK = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  type: 'reminder',
  status: 'pending',
  description: 'Check the electricity bill',
  due_at: '2026-08-11T16:03:00.000Z',
};

beforeEach(() => {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-number-id');
  vi.stubEnv('WHATSAPP_ROUTINE_MESSAGE_TEMPLATE', 'ra7etbal_routine_message');
  vi.stubEnv('WHATSAPP_TEMPLATE_LANGUAGE', 'en_US');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('owner reminder WhatsApp delivery', () => {
  it('atomically claims once, reuses the routine-template builder, and records acceptance only', async () => {
    const state = createDeliveryState();
    const fetchMock = createFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      deliverOwnerReminderWhatsapp(config(fetchMock)),
      deliverOwnerReminderWhatsapp(config(fetchMock)),
    ]);

    expect(first).toEqual(expect.objectContaining({
      attempted: true,
      status: 'accepted',
      deliveryId: 'delivery-1',
      metaMessageId: 'wamid.owner-reminder-1',
    }));
    expect(second).toEqual(expect.objectContaining({
      attempted: false,
      deliveryId: 'delivery-1',
    }));
    expect(state.metaPayloads).toHaveLength(1);
    expect(state.metaPayloads[0]).toEqual(buildRoutineMessagePayload({
      to: '905010589614',
      message: 'Reminder: Check the electricity bill. Due Tuesday at 7:03 PM.',
      templateName: 'ra7etbal_routine_message',
      templateLanguage: 'en_US',
    }));
    expect(state.deliveryPatches).toContainEqual(expect.objectContaining({
      delivery_status: 'accepted',
      meta_message_id: 'wamid.owner-reminder-1',
      accepted_at: expect.any(String),
    }));
    expect(state.deliveryPatches.flatMap(Object.keys)).not.toContain('delivered_at');
    expect(state.deliveryPatches.flatMap(Object.keys)).not.toContain('read_at');
    expect(state.taskPatches).toHaveLength(0);
  });

  it('records a synchronous Meta rejection without changing push truth fields', async () => {
    const state = createDeliveryState({ metaStatus: 400 });
    const fetchMock = createFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverOwnerReminderWhatsapp(config(fetchMock));

    expect(result).toEqual(expect.objectContaining({
      attempted: true,
      status: 'failed',
      deliveryId: 'delivery-1',
    }));
    expect(state.deliveryPatches).toContainEqual(expect.objectContaining({
      delivery_status: 'failed',
      failure_stage: 'meta_api',
      failure_http_status: 400,
    }));
    expect(state.taskPatches).toHaveLength(0);
  });

  it('selects only the exact household Boss and never sends to staff', async () => {
    const state = createDeliveryState({
      people: [
        { id: 'staff-1', name: 'Christopher', role: 'staff', phone: '+90 555 000 0000' },
        { id: 'owner-1', name: 'Boss', role: 'boss', phone: '+90 501 058 9614' },
      ],
    });
    const fetchMock = createFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    await deliverOwnerReminderWhatsapp(config(fetchMock));

    expect(state.metaPayloads).toHaveLength(1);
    expect(state.metaPayloads[0].to).toBe('905010589614');
    expect(JSON.stringify(state.metaPayloads[0])).not.toContain('905550000000');
    expect(state.requestedUserIds).toEqual(new Set([TASK.user_id]));
  });

  it('fails closed when the household has multiple Boss recipients', async () => {
    const state = createDeliveryState({
      people: [
        { id: 'owner-1', name: 'Boss', role: 'boss', phone: '+90 501 058 9614' },
        { id: 'owner-2', name: 'Other', role: 'boss', phone: '+90 501 000 0000' },
      ],
    });
    const fetchMock = createFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverOwnerReminderWhatsapp(config(fetchMock));

    expect(result).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(state.metaPayloads).toHaveLength(0);
    expect(state.deliveryPatches).toContainEqual(expect.objectContaining({
      delivery_status: 'failed',
      failure_stage: 'validation',
    }));
  });

  it('uses Europe/Istanbul when the profile timezone is missing or invalid', () => {
    expect(formatOwnerReminderMessage({
      description: 'Check the electricity bill.',
      dueAt: TASK.due_at,
      timezone: 'Invalid/Timezone',
    })).toBe('Reminder: Check the electricity bill. Due Tuesday at 7:03 PM.');
  });

  it('does not claim or send for a staff/delegation task', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await deliverOwnerReminderWhatsapp(config(fetchMock, {
      ...TASK,
      type: 'delegation',
      assigned_to: 'Christopher',
    }));

    expect(result).toEqual({
      attempted: false,
      status: 'skipped',
      reason: 'invalid_reminder_task',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function config(fetchImpl, task = TASK) {
  return {
    task,
    supabaseUrl: 'https://example.supabase.co',
    serviceRoleKey: 'service-key',
    fetchImpl,
  };
}

function createDeliveryState(overrides = {}) {
  return {
    claimed: false,
    deliveryStatus: 'pending',
    metaStatus: overrides.metaStatus ?? 200,
    people: overrides.people ?? [
      { id: 'owner-1', name: 'Boss', role: 'boss', phone: '+90 501 058 9614' },
    ],
    profiles: [{ display_name: 'Sana', morning_brief_timezone: 'Europe/Istanbul' }],
    metaPayloads: [],
    deliveryPatches: [],
    taskPatches: [],
    requestedUserIds: new Set(),
  };
}

function createFetch(state) {
  return vi.fn(async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith('/rest/v1/whatsapp_deliveries') && options.method === 'POST') {
      if (state.claimed) return jsonResponse([]);
      state.claimed = true;
      return jsonResponse([{ id: 'delivery-1', delivery_status: 'pending' }], 201);
    }
    if (value.includes('/rest/v1/whatsapp_deliveries?') && options.method !== 'PATCH') {
      return jsonResponse([{ id: 'delivery-1', delivery_status: state.deliveryStatus }]);
    }
    if (value.includes('/rest/v1/people?')) {
      state.requestedUserIds.add(new URL(value).searchParams.get('user_id').replace('eq.', ''));
      return jsonResponse(state.people);
    }
    if (value.includes('/rest/v1/profiles?')) {
      state.requestedUserIds.add(new URL(value).searchParams.get('id').replace('eq.', ''));
      return jsonResponse(state.profiles);
    }
    if (value.includes('/rest/v1/whatsapp_deliveries?') && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      state.deliveryPatches.push(body);
      if (body.delivery_status) state.deliveryStatus = body.delivery_status;
      return options.headers.Prefer === 'return=representation'
        ? jsonResponse([{ id: 'delivery-1' }])
        : emptyResponse();
    }
    if (value.includes('/rest/v1/tasks') && options.method === 'PATCH') {
      state.taskPatches.push(JSON.parse(options.body));
      return emptyResponse();
    }
    if (value.includes('graph.facebook.com')) {
      state.metaPayloads.push(JSON.parse(options.body));
      return state.metaStatus === 200
        ? textResponse({ messages: [{ id: 'wamid.owner-reminder-1' }] }, 200)
        : textResponse({ error: { message: 'Template rejected', code: 132001 } }, state.metaStatus);
    }
    throw new Error(`Unexpected fetch: ${value}`);
  });
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

function textResponse(body, status) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
}
