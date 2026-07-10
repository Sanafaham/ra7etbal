import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const smsMocks = vi.hoisted(() => ({
  buildSmsBody: vi.fn(({ messageText }) => `SMS: ${messageText}`),
  sendTwilioSms: vi.fn(async () => ({ ok: true, sid: 'SM123', error: null })),
}));

const taskConfirmMocks = vi.hoisted(() => ({
  sendOwnerPush: vi.fn(async () => {}),
}));

vi.mock('./send-whatsapp-task.js', () => ({
  buildSmsBody: smsMocks.buildSmsBody,
  sendTwilioSms: smsMocks.sendTwilioSms,
}));

vi.mock('./task-confirm.js', () => ({
  sendOwnerPush: taskConfirmMocks.sendOwnerPush,
}));

import {
  attemptAutomationMessageSmsFallback,
  buildDeliveryStatusPatch,
  getFailureDetails,
  updateWhatsappDeliveryStatus,
} from './whatsapp-webhook.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  smsMocks.buildSmsBody.mockClear();
  smsMocks.sendTwilioSms.mockClear();
  taskConfirmMocks.sendOwnerPush.mockClear();
});

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

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}
