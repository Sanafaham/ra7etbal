import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHmac } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

const smsMocks = vi.hoisted(() => ({
  buildSmsBody: vi.fn(({ messageText }) => `SMS: ${messageText}`),
  sendTwilioSms: vi.fn(async () => ({ ok: true, sid: 'SM123', error: null })),
  sendMetaMessage: vi.fn(async () => ({ ok: true, messageId: 'wamid.reply-1', metaError: null })),
}));

const taskConfirmMocks = vi.hoisted(() => ({
  sendOwnerPush: vi.fn(async () => {}),
  handleTaskConfirmationPost: vi.fn(async (_req, res) => res.status(200).json({ success: true, outcome: 'approved', description: 'Buy TEREA Silver' })),
}));

const staffEngineMocks = vi.hoisted(() => ({
  processStaffMessage: vi.fn(async () => ({
    ok: true,
    messageId: 'staff-message-1',
    response: 'Thanks, I recorded that.',
  })),
}));

const ownerRoutingMocks = vi.hoisted(() => ({
  handleInboundOwnerMessage: vi.fn(async () => ({ isOwner: false, reason: 'not_owner' })),
}));

const inboundObservabilityMocks = vi.hoisted(() => ({
  persistWhatsappInboundEvidence: vi.fn(async () => ({ ok: true })),
}));

vi.mock('./send-whatsapp-task.js', () => ({
  buildSmsBody: smsMocks.buildSmsBody,
  sendTwilioSms: smsMocks.sendTwilioSms,
  sendMetaMessage: smsMocks.sendMetaMessage,
}));

vi.mock('./task-confirm.js', () => ({
  sendOwnerPush: taskConfirmMocks.sendOwnerPush,
  handleTaskConfirmationPost: taskConfirmMocks.handleTaskConfirmationPost,
}));

vi.mock('./_staff-comms-engine.js', () => ({
  processStaffMessage: staffEngineMocks.processStaffMessage,
}));

vi.mock('./_owner-whatsapp-routing.js', () => ({
  handleInboundOwnerMessage: ownerRoutingMocks.handleInboundOwnerMessage,
}));

vi.mock('./_whatsapp-inbound-observability.js', () => ({
  persistWhatsappInboundEvidence: inboundObservabilityMocks.persistWhatsappInboundEvidence,
}));

import handler, {
  attemptAutomationMessageSmsFallback,
  buildDeliveryStatusPatch,
  extractInboundMessages,
  getFailureDetails,
  handleInboundStaffMessage,
  updateWhatsappDeliveryStatus,
  verifyMetaSignature,
} from './whatsapp-webhook.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  smsMocks.buildSmsBody.mockClear();
  smsMocks.sendTwilioSms.mockClear();
  smsMocks.sendMetaMessage.mockClear();
  taskConfirmMocks.sendOwnerPush.mockClear();
  taskConfirmMocks.handleTaskConfirmationPost.mockClear();
  staffEngineMocks.processStaffMessage.mockClear();
  ownerRoutingMocks.handleInboundOwnerMessage.mockClear();
  ownerRoutingMocks.handleInboundOwnerMessage.mockResolvedValue({ isOwner: false, reason: 'not_owner' });
  inboundObservabilityMocks.persistWhatsappInboundEvidence.mockClear();
  inboundObservabilityMocks.persistWhatsappInboundEvidence.mockResolvedValue({ ok: true });
});

function makeReqRes(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${createHmac('sha256', 'meta-app-secret').update(rawBody).digest('hex')}`;
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return {
    req: { method: 'POST', rawBody, headers: { 'x-hub-signature-256': signature } },
    res,
  };
}

function inboundMessagePayload({ from = '971501234567', messageId, text, contextMessageId = null }) {
  return {
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'meta-phone-id' },
          messages: [{
            from, id: messageId, type: 'text', text: { body: text }, timestamp: '1700000000',
            ...(contextMessageId ? { context: { id: contextMessageId } } : {}),
          }],
        },
      }],
    }],
  };
}

describe('owner routing precedence', () => {
  it('possible-owner ambiguity never reaches consent or staff routing', async () => {
    vi.stubEnv('META_APP_SECRET', 'meta-app-secret');
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
    ownerRoutingMocks.handleInboundOwnerMessage.mockResolvedValueOnce({
      isOwner: true, handled: false, route: 'identity_ambiguous',
      reason: 'canonical_owner_not_unique',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: vi.fn().mockResolvedValue([]),
    }));
    const { req, res } = makeReqRes(inboundMessagePayload({
      messageId: 'wamid.owner-ambiguous', text: 'STOP',
    }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ownerHandled).toBe(0);
    expect(staffEngineMocks.processStaffMessage).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('whatsapp_consent_log'))).toBe(false);
  });
});

function stubBaseEnv() {
  vi.stubEnv('SUPABASE_URL', 'https://x.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('META_APP_SECRET', 'meta-app-secret');
  vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key');
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-access-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', ''); // keeps recordWebhookHeartbeat a no-op
}

describe('WhatsApp delivery status progression', () => {
  it('advances accepted through sent, delivered, and read with timestamps', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'accepted',
        incomingStatus: 'sent',
        updatedAt: '2026-06-22T18:00:00Z',
        currentLastStatusAt: null,
      }),
    ).toEqual({
      delivery_status: 'sent',
      sent_at: '2026-06-22T18:00:00.000Z',
      last_status_at: '2026-06-22T18:00:00.000Z',
    });

    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'sent',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:01:00Z',
        currentLastStatusAt: '2026-06-22T18:00:00Z',
      }),
    ).toMatchObject({
      delivery_status: 'delivered',
      delivered_at: '2026-06-22T18:01:00.000Z',
    });

    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'delivered',
        incomingStatus: 'read',
        updatedAt: '2026-06-22T18:02:00Z',
        currentLastStatusAt: '2026-06-22T18:01:00Z',
      }),
    ).toMatchObject({
      delivery_status: 'read',
      read_at: '2026-06-22T18:02:00.000Z',
    });
  });

  it('does not regress state on an out-of-order webhook', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'read',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:03:00Z',
        currentLastStatusAt: '2026-06-22T18:02:00Z',
      }),
    ).toEqual({
      last_status_at: '2026-06-22T18:03:00.000Z',
    });
  });

  it('does not overwrite a milestone timestamp on a duplicate status', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'delivered',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:03:00Z',
        currentLastStatusAt: '2026-06-22T18:02:00Z',
      }),
    ).toEqual({
      last_status_at: '2026-06-22T18:03:00.000Z',
    });
  });

  it('makes failed terminal', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'accepted',
        incomingStatus: 'failed',
        updatedAt: '2026-06-22T18:04:00Z',
        failureReason: 'Recipient unavailable',
      }),
    ).toMatchObject({
      delivery_status: 'failed',
      failed_at: '2026-06-22T18:04:00.000Z',
      failure_stage: 'meta_api',
      failure_reason: 'Recipient unavailable',
    });

    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'failed',
        incomingStatus: 'delivered',
        updatedAt: '2026-06-22T18:05:00Z',
      }),
    ).toBeNull();
  });

  it('a failed webhook status carries the Meta error code/subcode into the patch (previously dropped)', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'sent',
        incomingStatus: 'failed',
        updatedAt: '2026-06-27T14:30:09Z',
        failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
        failureCode: 131049,
        failureSubcode: 2494,
      }),
    ).toMatchObject({
      delivery_status: 'failed',
      failure_reason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failure_code: '131049',
      failure_subcode: '2494',
    });
  });

  it('a failed status with no code/subcode reported stores null rather than a stray string', () => {
    expect(
      buildDeliveryStatusPatch({
        currentStatus: 'sent',
        incomingStatus: 'failed',
        updatedAt: '2026-06-27T14:30:09Z',
        failureReason: 'WhatsApp delivery failed.',
      }),
    ).toMatchObject({
      failure_code: null,
      failure_subcode: null,
    });
  });

  it('fails open when canonical delivery storage is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('database unavailable')));

    await expect(
      updateWhatsappDeliveryStatus({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        messageId: 'wamid.1',
        status: 'delivered',
        updatedAt: '2026-06-22T18:01:00Z',
      }),
    ).resolves.toMatchObject({
      matched: false,
      updated: false,
      error: 'unexpected_error',
    });
  });

  it('updates the matched delivery and health timestamps', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-1',
          user_id: 'user-1',
          delivery_status: 'accepted',
          last_status_at: null,
        },
      ]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'delivered',
      updatedAt: '2026-06-22T18:01:00Z',
      phoneNumberId: 'phone-number-1',
      webhookReceivedAt: '2026-06-22T18:01:05Z',
    });

    expect(result).toMatchObject({
      matched: true,
      updated: true,
      deliveryId: 'delivery-1',
    });

    const healthBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(healthBody).toMatchObject({
      user_id: 'user-1',
      phone_number_id: 'phone-number-1',
      last_webhook_received_at: '2026-06-22T18:01:05Z',
      last_status_webhook_at: '2026-06-22T18:01:05Z',
      last_matched_status_at: '2026-06-22T18:01:05Z',
      last_delivered_at: '2026-06-22T18:01:05Z',
    });

    const deliveryBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(deliveryBody).toEqual({
      delivery_status: 'delivered',
      delivered_at: '2026-06-22T18:01:00.000Z',
      last_status_at: '2026-06-22T18:01:00.000Z',
    });
  });

  it('a failed status carries failureCode/failureSubcode all the way into the delivery PATCH body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-1',
          user_id: 'user-1',
          delivery_status: 'sent',
          last_status_at: '2026-06-27T14:30:04Z',
          automation_run_id: null,
          source_type: 'automation_message',
        },
      ]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'failed',
      updatedAt: '2026-06-27T14:30:09Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: 2494,
      phoneNumberId: 'phone-number-1',
    });

    expect(result).toMatchObject({ matched: true, updated: true });

    const deliveryBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(deliveryBody).toMatchObject({
      delivery_status: 'failed',
      failure_reason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failure_code: '131049',
      failure_subcode: '2494',
    });
  });
});

describe('getFailureDetails — Meta webhook error extraction', () => {
  it('extracts reason, code, and subcode together (previously only reason was kept)', () => {
    expect(
      getFailureDetails({
        errors: [
          {
            code: 131049,
            error_subcode: 2494,
            title: 'Unable to deliver message',
            message: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
          },
        ],
      }),
    ).toEqual({
      reason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      code: 131049,
      subcode: 2494,
    });
  });

  it('returns nulls when there are no errors on the status entry', () => {
    expect(getFailureDetails({})).toEqual({ reason: null, code: null, subcode: null });
  });

  it('falls back to a generic reason when Meta sends a code with no message/title', () => {
    expect(getFailureDetails({ errors: [{ code: 470 }] })).toEqual({
      reason: '470',
      code: 470,
      subcode: null,
    });
  });
});

describe('attemptAutomationMessageSmsFallback — recurring automation 131049 fallback', () => {
  function configureSmsEnv() {
    vi.stubEnv('SMS_FALLBACK_ENABLED', 'true');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC123');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token123');
    vi.stubEnv('TWILIO_FROM_NUMBER', '+15550001111');
  }

  it('skips (fail-open) when SMS_FALLBACK_ENABLED is not set — the production default today', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await attemptAutomationMessageSmsFallback({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      delivery: {
        id: 'delivery-1',
        recipient_phone: '971500000000',
        metadata: { message_text: 'Drink water reminder' },
      },
    });

    expect(result).toEqual({ attempted: false, reason: 'not_configured' });
    expect(smsMocks.sendTwilioSms).not.toHaveBeenCalled();
  });

  it('skips when Twilio creds are configured but the recipient has no phone on the delivery row', async () => {
    configureSmsEnv();
    const result = await attemptAutomationMessageSmsFallback({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      delivery: { id: 'delivery-1', recipient_phone: null, metadata: { message_text: 'Hi' } },
    });

    expect(result).toEqual({ attempted: false, reason: 'not_configured' });
    expect(smsMocks.sendTwilioSms).not.toHaveBeenCalled();
  });

  it('skips when no message text was stored on the delivery row (older deliveries pre-dating this fix)', async () => {
    configureSmsEnv();
    const result = await attemptAutomationMessageSmsFallback({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      delivery: { id: 'delivery-1', recipient_phone: '971500000000', metadata: {} },
    });

    expect(result).toEqual({ attempted: false, reason: 'no_message_text' });
    expect(smsMocks.sendTwilioSms).not.toHaveBeenCalled();
  });

  it('sends the SMS and records the outcome in metadata when fully configured', async () => {
    configureSmsEnv();
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await attemptAutomationMessageSmsFallback({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      delivery: {
        id: 'delivery-1',
        recipient_phone: '971500000000',
        metadata: { send_mode: 'routine_message', message_text: 'Take your medicine' },
      },
    });

    expect(result).toEqual({ attempted: true, sent: true });
    expect(smsMocks.sendTwilioSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: '971500000000', accountSid: 'AC123', fromNumber: '+15550001111' }),
    );

    const patchBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(patchBody.metadata).toMatchObject({
      send_mode: 'routine_message',
      message_text: 'Take your medicine',
      sms_fallback: { sent: true, sid: 'SM123', error: null },
    });
  });

  it('records a failed outcome without throwing when the Twilio send itself fails', async () => {
    configureSmsEnv();
    smsMocks.sendTwilioSms.mockResolvedValueOnce({ ok: false, sid: null, error: 'Twilio rejected number' });
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await attemptAutomationMessageSmsFallback({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      delivery: { id: 'delivery-1', recipient_phone: '971500000000', metadata: { message_text: 'Hi' } },
    });

    expect(result).toEqual({ attempted: true, sent: false });
    const patchBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(patchBody.metadata.sms_fallback).toMatchObject({ sent: false, sid: null, error: 'Twilio rejected number' });
  });
});

describe('updateWhatsappDeliveryStatus — SMS fallback trigger gating', () => {
  function mockDeliveryLookupAndPatch({ sourceType, recipientPhone = '971500000000', extraCalls = [] }) {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-1',
          user_id: 'user-1',
          delivery_status: 'sent',
          last_status_at: '2026-06-27T14:30:04Z',
          automation_run_id: 'run-1',
          source_type: sourceType,
          recipient_phone: recipientPhone,
          metadata: { message_text: 'Drink water' },
        },
      ]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }])) // delivery patch
      .mockResolvedValueOnce(jsonResponse([], 200)) // automation_runs patch
      .mockImplementation((...args) => {
        for (const call of extraCalls) call();
        return Promise.resolve(jsonResponse([{ id: 'delivery-1' }]));
      });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('triggers the SMS fallback for source_type=automation_message + failureCode=131049', async () => {
    configureSmsEnvGlobal();
    mockDeliveryLookupAndPatch({ sourceType: 'automation_message' });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'failed',
      updatedAt: '2026-06-27T14:30:09Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: 2494,
    });

    expect(smsMocks.sendTwilioSms).toHaveBeenCalledTimes(1);
  });

  it('does NOT trigger the SMS fallback for a different failure code on the same source_type', async () => {
    configureSmsEnvGlobal();
    mockDeliveryLookupAndPatch({ sourceType: 'automation_message' });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'failed',
      updatedAt: '2026-06-27T14:30:09Z',
      failureReason: 'Recipient number invalid.',
      failureCode: 131026,
      failureSubcode: null,
    });

    expect(smsMocks.sendTwilioSms).not.toHaveBeenCalled();
  });

  it('does NOT trigger the SMS fallback for 131049 on a non-automation_message source_type (e.g. delegation)', async () => {
    configureSmsEnvGlobal();
    mockDeliveryLookupAndPatch({ sourceType: 'automation_delegation' });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'failed',
      updatedAt: '2026-06-27T14:30:09Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: 2494,
    });

    expect(smsMocks.sendTwilioSms).not.toHaveBeenCalled();
  });

  function configureSmsEnvGlobal() {
    vi.stubEnv('SMS_FALLBACK_ENABLED', 'true');
    vi.stubEnv('TWILIO_ACCOUNT_SID', 'AC123');
    vi.stubEnv('TWILIO_AUTH_TOKEN', 'token123');
    vi.stubEnv('TWILIO_FROM_NUMBER', '+15550001111');
  }
});

describe('updateWhatsappDeliveryStatus — Bug #1 fix: reopen substitute_review after async delivery failure', () => {
  function mockLookupPatchAndRpc({ rpcResponse, sourceType = 'message', currentStatus = 'accepted' }) {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-1',
          user_id: 'user-1',
          delivery_status: currentStatus,
          last_status_at: '2026-07-10T04:49:27Z',
          automation_run_id: null,
          source_type: sourceType,
          recipient_phone: '+905010589614',
          metadata: {},
        },
      ])) // lookup
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-1' }])) // delivery PATCH (CAS) — matched, updated
      .mockResolvedValueOnce(jsonResponse(rpcResponse)); // reopen_substitute_decision_on_delivery_failure RPC
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('reopens substitute_review and sends exactly one owner push when a Custom Instruction delivery fails asynchronously', async () => {
    const fetchMock = mockLookupPatchAndRpc({
      rpcResponse: [{ task_id: 'task-1', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', reopened: true }],
    });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'failed',
      updatedAt: '2026-07-10T04:49:27Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: null,
    });

    const rpcCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/rpc/reopen_substitute_decision_on_delivery_failure'),
    );
    expect(rpcCall).toBeDefined();
    expect(JSON.parse(rpcCall[1].body)).toEqual({ p_delivery_id: 'delivery-1' });
    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledTimes(1);
    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', assignedTo: 'Ghulam', variant: 'substitute_delivery_failed' }),
    );
  });

  it('reopens substitute_review and sends exactly one owner push when a Reject Alternative delivery fails asynchronously', async () => {
    // The decision-type gate (rejected_alternative vs custom_instruction) lives in the
    // SQL function itself and was verified live against the deployed migration; this
    // test only proves the JS-side RPC/push wiring is agnostic to which one reopened.
    mockLookupPatchAndRpc({
      rpcResponse: [{ task_id: 'task-2', user_id: 'user-1', description: 'buy the flowers', assigned_to: 'Grace', reopened: true }],
    });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.2',
      status: 'failed',
      updatedAt: '2026-07-10T05:00:00Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: null,
    });

    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledTimes(1);
    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: 'Grace', variant: 'substitute_delivery_failed' }),
    );
  });

  it('an unrelated ordinary WhatsApp failure (no linked substitute decision) is a safe RPC no-op — existing failure handling is unaffected', async () => {
    const result = await (async () => {
      mockLookupPatchAndRpc({
        rpcResponse: [{ task_id: null, user_id: null, description: null, assigned_to: null, reopened: false }],
        sourceType: 'delegation',
      });
      return updateWhatsappDeliveryStatus({
        supabaseUrl: 'https://example.supabase.co',
        serviceKey: 'service-key',
        messageId: 'wamid.4',
        status: 'failed',
        updatedAt: '2026-07-10T05:00:00Z',
        failureReason: 'Recipient number invalid.',
        failureCode: 131026,
        failureSubcode: null,
      });
    })();

    expect(result).toEqual(expect.objectContaining({ matched: true, updated: true }));
    expect(taskConfirmMocks.sendOwnerPush).not.toHaveBeenCalled();
  });

  it('duplicate Meta failure callback for an already-failed delivery never calls the reopen RPC or sends a second push (idempotent via the existing terminal-failed CAS gate)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-1',
          user_id: 'user-1',
          delivery_status: 'failed', // already terminal
          last_status_at: '2026-07-10T04:49:27Z',
          automation_run_id: null,
          source_type: 'message',
          recipient_phone: '+905010589614',
          metadata: {},
        },
      ]));
    vi.stubGlobal('fetch', fetchMock);

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.1',
      status: 'failed',
      updatedAt: '2026-07-10T04:50:00Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: null,
    });

    // buildDeliveryStatusPatch returns null once currentStatus is already 'failed' —
    // no PATCH call, no reopen RPC call, no duplicate push.
    expect(fetchMock).toHaveBeenCalledTimes(1); // lookup only
    expect(taskConfirmMocks.sendOwnerPush).not.toHaveBeenCalled();
  });

  it('reopens substitute_review and sends exactly one owner push when an Approve Alternative delivery fails asynchronously (2026-07-12: Approve now sends a real message, so it needs the same reopen coverage)', async () => {
    mockLookupPatchAndRpc({
      rpcResponse: [{ task_id: 'task-3', user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Ghulam', reopened: true }],
    });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.3',
      status: 'failed',
      updatedAt: '2026-07-10T18:00:00Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: null,
    });

    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledTimes(1);
    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', assignedTo: 'Ghulam', variant: 'substitute_delivery_failed' }),
    );
  });

  it('the live reopen filter now covers all three decision types, including approved_alternative (2026-07-12 fix — source-level regression guard against the premature-completion bug reappearing)', () => {
    const migrationSource = readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', '20260712_approve_alternative_message_first.sql'),
      'utf-8',
    );
    expect(migrationSource).toContain("decision IN ('rejected_alternative', 'custom_instruction', 'approved_alternative')");
  });
});

describe('updateWhatsappDeliveryStatus — Workstream 5: staff-facing outbound delivery reliability', () => {
  function mockPlainMessageFailure({ reopened = false, existingMetadata = {} } = {}) {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-5',
          user_id: 'user-1',
          delivery_status: 'accepted',
          last_status_at: '2026-08-06T12:34:08Z',
          automation_run_id: null,
          source_type: 'message',
          recipient_phone: '+905010589614',
          recipient_name: 'Christopher',
          metadata: existingMetadata,
        },
      ])) // lookup
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-5' }])) // CAS PATCH — matched, updated
      .mockResolvedValueOnce(jsonResponse([{ task_id: null, user_id: null, description: null, assigned_to: null, reopened }])) // reopen RPC
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-5' }])); // delivery_failure_notice metadata PATCH
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('notifies the owner exactly once when a plain direct-message send fails asynchronously and the reopen RPC does not claim it', async () => {
    const fetchMock = mockPlainMessageFailure({ reopened: false });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.5',
      status: 'failed',
      updatedAt: '2026-08-06T12:34:09Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: null,
    });

    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledTimes(1);
    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', assignedTo: 'Christopher', variant: 'staff_delivery_failed' }),
    );

    const noticeCall = fetchMock.mock.calls[3];
    expect(String(noticeCall[0])).toContain('/whatsapp_deliveries?id=eq.delivery-5');
    const noticeBody = JSON.parse(noticeCall[1].body);
    expect(noticeBody.metadata.delivery_failure_notice).toEqual(
      expect.objectContaining({ variant: 'staff_delivery_failed', notified_at: expect.any(String) }),
    );
  });

  it('does not send a second, duplicate owner notification when the reopen RPC already claimed and handled the failure', async () => {
    mockPlainMessageFailure({ reopened: true });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.6',
      status: 'failed',
      updatedAt: '2026-08-06T12:34:09Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: null,
    });

    // reopenSubstituteReviewIfApplicable already sent its own push (mocked to a
    // no-op here since only the WS5 gating is under test); the new WS5 path
    // must see reopened: true and stay silent, not send a second push.
    expect(taskConfirmMocks.sendOwnerPush).toHaveBeenCalledTimes(1);
    expect(taskConfirmMocks.sendOwnerPush).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'staff_delivery_failed' }),
    );
  });

  it('never fires for source_type other than message (e.g. delegation), even when the reopen RPC does not claim it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse([
        {
          id: 'delivery-7',
          user_id: 'user-1',
          delivery_status: 'accepted',
          last_status_at: '2026-08-06T12:34:08Z',
          automation_run_id: null,
          source_type: 'delegation',
          recipient_phone: '+12025691377',
          recipient_name: 'Christopher',
          metadata: {},
        },
      ]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'delivery-7' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: null, user_id: null, description: null, assigned_to: null, reopened: false }]));
    vi.stubGlobal('fetch', fetchMock);

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.7',
      status: 'failed',
      updatedAt: '2026-08-06T12:34:09Z',
      failureReason: 'Recipient number invalid.',
      failureCode: 131026,
      failureSubcode: null,
    });

    expect(taskConfirmMocks.sendOwnerPush).not.toHaveBeenCalled();
    // No fourth (notice) call beyond lookup/CAS/RPC — nothing to record.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('is idempotent if metadata already records a prior delivery_failure_notice (defense-in-depth beyond the single-fire CAS gate)', async () => {
    const fetchMock = mockPlainMessageFailure({
      reopened: false,
      existingMetadata: { delivery_failure_notice: { notified_at: '2026-08-06T12:00:00Z', variant: 'staff_delivery_failed' } },
    });

    await updateWhatsappDeliveryStatus({
      supabaseUrl: 'https://example.supabase.co',
      serviceKey: 'service-key',
      messageId: 'wamid.8',
      status: 'failed',
      updatedAt: '2026-08-06T12:34:09Z',
      failureReason: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.',
      failureCode: 131049,
      failureSubcode: null,
    });

    expect(taskConfirmMocks.sendOwnerPush).not.toHaveBeenCalled();
    // Only lookup/CAS/RPC — no redundant metadata PATCH either.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('verified inbound staff transport', () => {
  it('preserves raw quoted context separately from normalized routing context', () => {
    const payload = inboundMessagePayload({
      messageId: 'wamid.inbound-quoted', text: 'Approve it',
      contextMessageId: 'wamid.owner-review',
    });
    payload.entry[0].changes[0].value.messages[0].context.from = '1196495893537506';
    const [message] = extractInboundMessages(payload, '2026-08-05T19:53:21.700Z');
    expect(message.contextMessageId).toBe('wamid.owner-review');
    expect(message.inboundEvidence).toEqual({
      inboundMetaMessageId: 'wamid.inbound-quoted',
      contextPresent: true,
      rawContextId: 'wamid.owner-review',
      rawContextFrom: '1196495893537506',
      messageType: 'text',
      senderPhone: '971501234567',
      businessNumberId: 'meta-phone-id',
      webhookReceivedAt: '2026-08-05T19:53:21.700Z',
    });
  });

  it.each([
    ['missing', undefined, false, null],
    ['explicit null', null, true, null],
    ['malformed scalar', 'malformed', true, null],
    ['malformed id', { id: { unexpected: true }, from: 42 }, true, { unexpected: true }],
  ])('preserves %s raw context evidence without changing normalized routing', (_label, context, present, rawId) => {
    const payload = inboundMessagePayload({ messageId: `wamid.${_label}`, text: 'Approve it' });
    if (context !== undefined) payload.entry[0].changes[0].value.messages[0].context = context;
    const [message] = extractInboundMessages(payload, '2026-08-05T19:53:21.700Z');
    expect(message.inboundEvidence.contextPresent).toBe(present);
    expect(message.inboundEvidence.rawContextId).toEqual(rawId);
    expect(message.contextMessageId).toBe(
      _label === 'malformed id' ? '[object Object]' : null,
    );
  });

  it('persists inbound evidence before invoking owner routing', async () => {
    stubBaseEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])));
    const order = [];
    inboundObservabilityMocks.persistWhatsappInboundEvidence.mockImplementationOnce(async () => {
      order.push('evidence');
      return { ok: true };
    });
    ownerRoutingMocks.handleInboundOwnerMessage.mockImplementationOnce(async () => {
      order.push('routing');
      return { isOwner: true, handled: true };
    });
    const { req, res } = makeReqRes(inboundMessagePayload({
      messageId: 'wamid.audit-order', text: 'Approve it', contextMessageId: 'wamid.owner-review',
    }));
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(order).toEqual(['evidence', 'routing']);
    expect(inboundObservabilityMocks.persistWhatsappInboundEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        evidence: expect.objectContaining({ rawContextId: 'wamid.owner-review' }),
        normalizedMessage: expect.objectContaining({ contextMessageId: 'wamid.owner-review' }),
      }),
    );
  });

  it('extracts a captionless WhatsApp image as valid inbound evidence', () => {
    expect(extractInboundMessages({
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: 'meta-phone-id' },
        messages: [{
          from: '971501234567', id: 'wamid.photo', type: 'image', timestamp: '1700000000',
          image: { id: 'media-1', mime_type: 'image/jpeg' }, context: { id: 'wamid.task' },
        }],
      } }] }],
    })).toEqual([expect.objectContaining({
      from: '971501234567', messageId: 'wamid.photo', body: '',
      contextMessageId: 'wamid.task', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg',
    })]);
  });

  it('rejects invalid Meta signatures before touching dependencies', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { req, res } = makeReqRes({ entry: [] });
    req.headers['x-hub-signature-256'] = 'sha256=' + '0'.repeat(64);
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves one household/person, preserves reply task context, and leases one outbound send', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: 'Buy TEREA Silver' }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-1', claimed: true, claim_token: 'claim-1', response_text: 'Recorded.' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-1' }]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: { from: '971501234567', messageId: 'wamid.in-1', body: 'Done', phoneNumberId: 'meta-phone-id', contextMessageId: 'wamid.out-1', timestamp: '1700000000' },
    });
    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(staffEngineMocks.processStaffMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', personId: 'person-1', taskId: 'task-1', externalMessageId: 'wamid.in-1' }), expect.any(Object));
    expect(smsMocks.sendMetaMessage).toHaveBeenCalledTimes(1);
  });

  it('routes a captionless quoted staff photo into the canonical task lifecycle exactly once', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: 'Buy TEREA Silver' }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', is_new: true, processing_status: 'claimed' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', claimed: true, claim_token: 'claim-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn(async () => ({
      ok: true, storagePath: 'task-images/user-1/task-1/proof/whatsapp-photo.jpg', mimeType: 'image/jpeg', size: 3,
    }));

    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      req: { headers: { host: 'www.ra7etbal.com' } },
      msg: {
        from: '971501234567', messageId: 'wamid.photo-1', body: '', phoneNumberId: 'meta-phone-id',
        contextMessageId: 'wamid.out-1', timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg',
      },
    }, { persistInboundStaffImageImpl });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(persistInboundStaffImageImpl).toHaveBeenCalledOnce();
    expect(taskConfirmMocks.handleTaskConfirmationPost).toHaveBeenCalledOnce();
    expect(taskConfirmMocks.handleTaskConfirmationPost.mock.calls[0][0].body).toEqual({
      taskId: 'task-1', confirmedBy: 'Christopher',
      proofImagePaths: ['task-images/user-1/task-1/proof/whatsapp-photo.jpg'],
    });
    expect(taskConfirmMocks.handleTaskConfirmationPost.mock.calls[0][2]).toEqual({ confirmationSource: 'whatsapp_staff' });
    expect(staffEngineMocks.processStaffMessage).not.toHaveBeenCalled();
    expect(smsMocks.sendMetaMessage).toHaveBeenCalledOnce();
  });

  it('never falls back from an unmatched quoted photo to an unrelated pending task', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', is_new: true, processing_status: 'claimed' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', claimed: true, claim_token: 'claim-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn();

    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: {
        from: '971501234567', messageId: 'wamid.photo-unmatched', body: '', phoneNumberId: 'meta-phone-id',
        contextMessageId: 'wamid.not-a-task', timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg',
      },
    }, { persistInboundStaffImageImpl });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(persistInboundStaffImageImpl).not.toHaveBeenCalled();
    expect(taskConfirmMocks.handleTaskConfirmationPost).not.toHaveBeenCalled();
    expect(smsMocks.sendMetaMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ text: { body: 'Which task is this photo for?' } }),
    }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rest/v1/messages?') && String(url).includes('recipient=eq.'))).toBe(false);
  });

  it('fails closed with numbered task descriptions and sends one clarification across concurrent and retried ambiguous photo webhooks', async () => {
    stubBaseEnv();
    let existingReads = 0;
    let evidenceClaims = 0;
    let responseClaims = 0;
    const fetchMock = vi.fn(async (url, options = {}) => {
      const requestUrl = String(url);
      const body = options.body ? JSON.parse(options.body) : {};
      if (requestUrl.includes('/rest/v1/whatsapp_health_state?')) return jsonResponse([{ user_id: 'user-1' }]);
      if (requestUrl.includes('/rest/v1/people?')) return jsonResponse([{
        id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false,
        whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed',
      }]);
      if (requestUrl.includes('/rest/v1/messages?') && requestUrl.includes('recipient=eq.Christopher')) {
        return jsonResponse([{ task_id: 'task-glass' }, { task_id: 'task-terea' }]);
      }
      if (requestUrl.includes('/rest/v1/tasks?') && requestUrl.includes('id=eq.task-glass')) {
        return jsonResponse([{ id: 'task-glass', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: '  Place the drinking glass\n\non the counter  ' }]);
      }
      if (requestUrl.includes('/rest/v1/tasks?') && requestUrl.includes('id=eq.task-terea')) {
        return jsonResponse([{ id: 'task-terea', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: 'Buy TEREA Silver' }]);
      }
      if (requestUrl.includes('/rest/v1/staff_messages?')) {
        existingReads += 1;
        return existingReads <= 2
          ? jsonResponse([])
          : jsonResponse([{
              id: 'staff-message-ambiguous', task_id: null, thread_id: null,
              inbound_text: '[Photo evidence]', processing_status: 'completed',
              classification: 'clarification_request', user_facing_state: 'Waiting',
              next_action_owner: 'staff', owner_attention_required: false,
              carson_response: 'stored numbered clarification',
            }]);
      }
      if (requestUrl.includes('/rpc/claim_staff_message')) {
        expect(body).toMatchObject({ p_task_id: null, p_thread_id: null });
        evidenceClaims += 1;
        return jsonResponse([{
          message_id: 'staff-message-ambiguous',
          is_new: evidenceClaims === 1,
          processing_status: 'claimed',
        }]);
      }
      if (requestUrl.includes('/rpc/complete_staff_message')) return jsonResponse([{ id: 'staff-message-ambiguous' }]);
      if (requestUrl.includes('/rpc/claim_staff_response_delivery')) {
        responseClaims += 1;
        return jsonResponse(responseClaims === 1
          ? [{ message_id: 'staff-message-ambiguous', claimed: true, claim_token: 'claim-1' }]
          : [{ message_id: 'staff-message-ambiguous', claimed: false }]);
      }
      if (requestUrl.includes('/rpc/complete_staff_response_delivery')) return jsonResponse([{ id: 'staff-message-ambiguous' }]);
      throw new Error(`Unexpected fetch: ${requestUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn();
    const input = {
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: {
        from: '971501234567', messageId: 'wamid.ambiguous-photo', body: '', phoneNumberId: 'meta-phone-id',
        contextMessageId: null, timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg',
      },
    };

    const concurrentResults = await Promise.all([
      handleInboundStaffMessage(input, { persistInboundStaffImageImpl }),
      handleInboundStaffMessage(input, { persistInboundStaffImageImpl }),
    ]);
    expect(concurrentResults).toEqual(expect.arrayContaining([
      { handled: true, reason: 'delivered' },
      { handled: true, reason: 'evidence_already_claimed' },
    ]));
    const clarification = smsMocks.sendMetaMessage.mock.calls[0][0].payload.text.body;
    expect(clarification).toBe([
      'I have two open tasks for you:',
      '',
      '1. Place the drinking glass on the counter',
      '2. Buy TEREA Silver',
      '',
      'Please use WhatsApp Reply on the correct task message and resend the photo.',
    ].join('\n'));
    expect(persistInboundStaffImageImpl).not.toHaveBeenCalled();
    expect(taskConfirmMocks.handleTaskConfirmationPost).not.toHaveBeenCalled();
    expect(evidenceClaims).toBe(2);

    await expect(handleInboundStaffMessage(input, { persistInboundStaffImageImpl }))
      .resolves.toEqual({ handled: true, reason: 'already_claimed' });
    expect(smsMocks.sendMetaMessage).toHaveBeenCalledTimes(1);
    expect(persistInboundStaffImageImpl).not.toHaveBeenCalled();
    expect(taskConfirmMocks.handleTaskConfirmationPost).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, options = {}]) =>
      (String(url).includes('/rest/v1/tasks') && options.method && options.method !== 'GET') ||
      String(url).includes('/storage/v1/object/') ||
      String(url).includes('/rest/v1/task_attachments'))).toBe(false);
  });

  it('keeps the existing single recent pending task fallback for an unquoted photo', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: 'Buy TEREA Silver' }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', is_new: true, processing_status: 'claimed' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', claimed: true, claim_token: 'claim-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn(async () => ({
      ok: true, storagePath: 'task-images/user-1/task-1/proof/unquoted.jpg', mimeType: 'image/jpeg', size: 3,
    }));

    await expect(handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: {
        from: '971501234567', messageId: 'wamid.unquoted-photo', body: '', phoneNumberId: 'meta-phone-id',
        contextMessageId: null, timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg',
      },
    }, { persistInboundStaffImageImpl })).resolves.toEqual({ handled: true, reason: 'delivered' });

    expect(persistInboundStaffImageImpl).toHaveBeenCalledOnce();
    expect(taskConfirmMocks.handleTaskConfirmationPost).toHaveBeenCalledOnce();
    expect(taskConfirmMocks.handleTaskConfirmationPost.mock.calls[0][0].body.taskId).toBe('task-1');
  });

  it('keeps a separate unquoted completion text attached to the just-completed photo task', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'done', assigned_to: 'Christopher', description: 'Buy TEREA Silver' }]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-text', claimed: true, claim_token: 'claim-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-text' }]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: {
        from: '971501234567', messageId: 'wamid.text-after-photo', body: 'Yes I bought it.',
        phoneNumberId: 'meta-phone-id', contextMessageId: null, timestamp: '1700000000', mediaId: null,
      },
    });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(staffEngineMocks.processStaffMessage).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', text: 'Yes I bought it.' }),
      expect.any(Object),
    );
    expect(taskConfirmMocks.handleTaskConfirmationPost).not.toHaveBeenCalled();
  });

  it('a failed evidence row is atomically reclaimed before exactly one canonical retry', async () => {
    stubBaseEnv();
    const failedAt = '2026-08-04T12:00:00.000Z';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: 'Buy TEREA Silver', quality_review_status: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo', task_id: 'task-1', inbound_text: '[Photo evidence]', processing_status: 'failed', updated_at: failedAt }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', acquired: true, processing_status: 'claimed' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', claimed: true, claim_token: 'claim-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn(async () => ({ ok: true, storagePath: 'task-images/user-1/task-1/proof/retry.jpg' }));

    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: { from: '971501234567', messageId: 'wamid.retry', body: '', phoneNumberId: 'meta-phone-id', contextMessageId: 'wamid.out-1', timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg' },
    }, { persistInboundStaffImageImpl });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    const reclaimCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/rpc/reclaim_staff_evidence_message'));
    expect(JSON.parse(reclaimCall[1].body)).toEqual({
      p_id: 'staff-message-photo', p_user_id: 'user-1', p_expected_updated_at: failedAt,
    });
    expect(persistInboundStaffImageImpl).toHaveBeenCalledOnce();
    expect(taskConfirmMocks.handleTaskConfirmationPost).toHaveBeenCalledOnce();
  });

  it('a reclaimed unbound ambiguous photo cannot adopt a newly unique pending task', async () => {
    stubBaseEnv();
    const failedAt = '2026-08-04T12:00:00.000Z';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'newly-unique-task' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'newly-unique-task', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: 'Place the drinking glass on the counter', quality_review_status: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo', task_id: null, thread_id: null, inbound_text: '[Photo evidence]', processing_status: 'failed', updated_at: failedAt }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', acquired: true, processing_status: 'claimed' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', claimed: true, claim_token: 'claim-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn();

    await expect(handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: {
        from: '971501234567', messageId: 'wamid.reclaimed-unbound', body: '', phoneNumberId: 'meta-phone-id',
        contextMessageId: null, timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg',
      },
    }, { persistInboundStaffImageImpl })).resolves.toEqual({ handled: true, reason: 'delivered' });

    expect(smsMocks.sendMetaMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ text: { body: 'Which task is this photo for?' } }),
    }));
    expect(persistInboundStaffImageImpl).not.toHaveBeenCalled();
    expect(taskConfirmMocks.handleTaskConfirmationPost).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url, options = {}]) =>
      (String(url).includes('/rest/v1/tasks') && options.method && options.method !== 'GET') ||
      String(url).includes('/storage/v1/object/') ||
      String(url).includes('/rest/v1/task_attachments'))).toBe(false);
  });

  it('a concurrent reclaim loser performs no media, QI, task, or notification work', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'pending', assigned_to: 'Christopher', description: 'Buy TEREA Silver', quality_review_status: null }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo', task_id: 'task-1', inbound_text: '[Photo evidence]', processing_status: 'failed', updated_at: '2026-08-04T12:00:00.000Z' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', acquired: false, processing_status: 'claimed' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn();

    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: { from: '971501234567', messageId: 'wamid.retry-loser', body: '', phoneNumberId: 'meta-phone-id', contextMessageId: 'wamid.out-1', timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg' },
    }, { persistInboundStaffImageImpl });

    expect(result).toEqual({ handled: true, reason: 'evidence_already_claimed' });
    expect(persistInboundStaffImageImpl).not.toHaveBeenCalled();
    expect(taskConfirmMocks.handleTaskConfirmationPost).not.toHaveBeenCalled();
    expect(smsMocks.sendMetaMessage).not.toHaveBeenCalled();
  });

  it('crash recovery after task approval completes evidence bookkeeping without rerunning QI', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher', phone: '+971501234567', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' }]))
      .mockResolvedValueOnce(jsonResponse([{ task_id: 'task-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'task-1', user_id: 'user-1', status: 'done', assigned_to: 'Christopher', description: 'Buy TEREA Silver', quality_review_status: 'approved' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo', task_id: 'task-1', inbound_text: '[Photo evidence]', processing_status: 'failed', updated_at: '2026-08-04T12:00:00.000Z' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', acquired: true, processing_status: 'claimed' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]))
      .mockResolvedValueOnce(jsonResponse([{ message_id: 'staff-message-photo', claimed: true, claim_token: 'claim-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'staff-message-photo' }]));
    vi.stubGlobal('fetch', fetchMock);
    const persistInboundStaffImageImpl = vi.fn();

    const result = await handleInboundStaffMessage({
      supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key',
      msg: { from: '971501234567', messageId: 'wamid.recover-approved', body: '', phoneNumberId: 'meta-phone-id', contextMessageId: 'wamid.out-1', timestamp: '1700000000', mediaId: 'media-1', mediaType: 'image', mimeType: 'image/jpeg' },
    }, { persistInboundStaffImageImpl });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(persistInboundStaffImageImpl).not.toHaveBeenCalled();
    expect(taskConfirmMocks.handleTaskConfirmationPost).not.toHaveBeenCalled();
    expect(smsMocks.sendMetaMessage).toHaveBeenCalledOnce();
  });

  it('rejects ambiguous and non-consented senders without invoking Carson or Meta', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'user-1' }]))
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', phone: '+971501234567', is_family: false, whatsapp_opted_in: true }]));
    vi.stubGlobal('fetch', fetchMock);
    const result = await handleInboundStaffMessage({ supabaseUrl: 'https://x.supabase.co', serviceKey: 'service-key', msg: { from: '971501234567', messageId: 'wamid.in-2', body: 'Done', phoneNumberId: 'meta-phone-id' } });
    expect(result.reason).toBe('not_opted_in');
    expect(staffEngineMocks.processStaffMessage).not.toHaveBeenCalled();
    expect(smsMocks.sendMetaMessage).not.toHaveBeenCalled();
  });
});

/* Legacy dispatch coverage removed: inbound staff transport is covered by
 * api/staff-message-response-delivery.test.js. */
describe.skip('POST /api/whatsapp-webhook — Carson bridge PoC dispatch (read-only)', () => {
  it('a consent reply still uses the existing consent path and never reaches the Carson bridge', async () => {
    stubBaseEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([]))); // findPersonByPhone -> no match, consent flow no-ops safely

    const { req, res } = makeReqRes(
      inboundMessagePayload({ messageId: 'wamid.consent-1', text: 'STOP' }),
    );
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(carsonBridgeMocks.attemptCarsonBridgePoc).not.toHaveBeenCalled();
  });

  it('one valid non-consent staff message calls the Carson bridge exactly once', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn(); // consent check exits before ever calling fetch for a non-consent body
    vi.stubGlobal('fetch', fetchMock);

    const { req, res } = makeReqRes(
      inboundMessagePayload({
        messageId: 'wamid.staff-1',
        text: 'We are out of strawberries. What should I do?',
      }),
    );
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.carsonBridgeHandled).toBe(1);
    expect(carsonBridgeMocks.attemptCarsonBridgePoc).toHaveBeenCalledTimes(1);
    expect(carsonBridgeMocks.attemptCarsonBridgePoc).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: expect.objectContaining({ messageId: 'wamid.staff-1', body: 'We are out of strawberries. What should I do?' }),
        findPersonByPhone: expect.any(Function),
      }),
    );
  });

  it('dispatching a staff message causes no outbound WhatsApp send and no database write', async () => {
    stubBaseEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { req, res } = makeReqRes(
      inboundMessagePayload({ messageId: 'wamid.staff-2', text: 'Can you check on the delivery?' }),
    );
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    // Zero Supabase/network calls at the dispatch layer itself — the bridge
    // module is mocked here and asserted separately in
    // _carson-agent-turn.test.js, so this proves the webhook handler adds no
    // side effects of its own beyond delegating to it.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(smsMocks.sendTwilioSms).not.toHaveBeenCalled();
    expect(taskConfirmMocks.sendOwnerPush).not.toHaveBeenCalled();
  });

  it('a status-only payload (no inbound messages) never touches the Carson bridge', async () => {
    stubBaseEnv();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ id: 'msg-1' })));

    const { req, res } = makeReqRes({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.status-1', status: 'delivered', timestamp: '1700000000' }] } }] }],
    });
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(carsonBridgeMocks.attemptCarsonBridgePoc).not.toHaveBeenCalled();
  });
});
