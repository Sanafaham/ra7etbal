import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { buildRoutineMessagePayload } from './send-whatsapp-task.js';

beforeEach(() => {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', '1234567890');
  vi.stubEnv('WHATSAPP_ROUTINE_MESSAGE_TEMPLATE', 'ra7etbal_routine_message');
  vi.stubEnv('WHATSAPP_TEMPLATE_LANGUAGE', 'en_US');
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('CRON_SECRET', 'cron-secret');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('routine message shared boundary', () => {
  it('preserves the approved routine template payload shape', () => {
    expect(
      buildRoutineMessagePayload({
        to: '971500000000',
        message: 'This is a recurring automation test.',
        templateName: 'ra7etbal_routine_message',
        templateLanguage: 'en_US',
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '971500000000',
      type: 'template',
      template: {
        name: 'ra7etbal_routine_message',
        language: { code: 'en_US' },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: 'This is a recurring automation test.',
              },
            ],
          },
        ],
      },
    });
  });

  it('rejects task/delegation sends without a confirmation link', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]))
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({
        to: '+971 50 000 0000',
        messageText: 'Please confirm the documents.',
        taskId: 'task-1',
        sourceType: 'delegation',
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Confirmation link is missing.',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/v1/tasks');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/rest/v1/whatsapp_deliveries');
    expect(String(fetchMock.mock.calls[2][0])).toContain('/rest/v1/whatsapp_deliveries?id=eq.delivery-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false);
  });

  it('keeps the routine/plain approved template path working without a confirmation link', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'routine-1', user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-routine-1' }]))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.routine' }] }))
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq(
        {
          to: '+971 50 000 0000',
          messageText: 'Recurring plain message.',
          routineId: 'routine-1',
          sourceType: 'routine_message',
          sendMode: 'routine_message',
        },
        { 'x-ra7etbal-internal-secret': 'cron-secret' },
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        sendMode: 'template',
        templateName: 'ra7etbal_routine_message',
      }),
    );
    const metaPayload = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(metaPayload).toEqual(
      buildRoutineMessagePayload({
        to: '971500000000',
        message: 'Recurring plain message.',
        templateName: 'ra7etbal_routine_message',
        templateLanguage: 'en_US',
      }),
    );
  });

  it('sends automation message runs with the default approved plain-message template when env is missing', async () => {
    vi.stubEnv('WHATSAPP_ROUTINE_MESSAGE_TEMPLATE', '');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'run-1', user_id: 'user-1', task_id: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-automation-1' }]))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.automation' }] }))
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq(
        {
          to: '+971 50 000 0000',
          messageText: 'Recurring automation test.',
          automationRunId: 'run-1',
          sourceType: 'automation_message',
          sendMode: 'routine_message',
          recipientName: 'Sana',
        },
        { 'x-ra7etbal-internal-secret': 'cron-secret' },
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        templateName: 'ra7etbal_routine_message',
        messageId: 'wamid.automation',
      }),
    );
    expect(String(fetchMock.mock.calls[0][0])).toContain('/rest/v1/automation_runs');

    const insertedDelivery = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(insertedDelivery).toMatchObject({
      user_id: 'user-1',
      automation_run_id: 'run-1',
      source_type: 'automation_message',
      delivery_status: 'pending',
      recipient_name: 'Sana',
    });

    const metaPayload = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(metaPayload).toEqual(
      buildRoutineMessagePayload({
        to: '971500000000',
        message: 'Recurring automation test.',
        templateName: 'ra7etbal_routine_message',
        templateLanguage: 'en_US',
      }),
    );
  });

  it('accepts a direct message without a confirmation link using the approved plain-message template', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'message-1', user_id: 'user-1', task_id: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-direct-1' }]))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.direct' }] }))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({
        to: '+971 50 000 0000',
        messageText: 'Ra7etBal notification test.',
        messageRecordId: 'message-1',
        sourceType: 'message',
        sendMode: 'direct_message',
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        sendMode: 'direct_message',
        sendType: 'template',
        channel: 'whatsapp',
        messageId: 'wamid.direct',
        templateName: 'ra7etbal_routine_message',
      }),
    );
    const metaPayload = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(metaPayload).toEqual(
      buildRoutineMessagePayload({
        to: '971500000000',
        message: 'Ra7etBal notification test.',
        templateName: 'ra7etbal_routine_message',
        templateLanguage: 'en_US',
      }),
    );
  });

  it('logs direct message delivery as a message with direct-message metadata', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'message-1', user_id: 'user-1', task_id: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-direct-1' }]))
      .mockResolvedValueOnce(jsonResponse({ messages: [{ id: 'wamid.direct' }] }))
      .mockResolvedValueOnce(emptyResponse())
      .mockResolvedValueOnce(emptyResponse());
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(
      createReq({
        to: '+971 50 000 0000',
        messageText: 'Direct delivery log test.',
        messageRecordId: 'message-1',
        sourceType: 'message',
        sendMode: 'direct_message',
      }),
      res,
    );

    const insertedDelivery = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(insertedDelivery).toMatchObject({
      user_id: 'user-1',
      message_id: 'message-1',
      task_id: null,
      source_type: 'message',
      delivery_status: 'pending',
      recipient_phone: '971500000000',
      metadata: expect.objectContaining({
        has_confirmation_link: false,
        send_mode: 'direct_message',
        direct_message: true,
      }),
    });

    const acceptedPatch = JSON.parse(fetchMock.mock.calls[4][1].body);
    expect(acceptedPatch).toMatchObject({
      delivery_status: 'accepted',
      meta_message_id: 'wamid.direct',
      template_name: 'ra7etbal_routine_message',
      metadata: expect.objectContaining({
        template_language: 'en_US',
        send_mode: 'direct_message',
        direct_message: true,
      }),
    });
  });
});

function createReq(body, headers = {}) {
  return {
    method: 'POST',
    headers,
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
