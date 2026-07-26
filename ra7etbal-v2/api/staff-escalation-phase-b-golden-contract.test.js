import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Phase B golden regression contract: owner WhatsApp notification for a
 * staff escalation, and the truthful staff-facing reply that depends on
 * its real outcome.
 *
 * Two layers, matching the paired-file/paired-describe convention already
 * established for the photo-workflow and alternative-review golden
 * contracts this session:
 *
 *  - "notifyOwnerOfEscalation" — the real function from
 *    api/_escalation-notify.js, calling the real claim_escalation_owner_
 *    decision RPC shape, the real findOwnerPhone, the real
 *    buildOwnerDecisionTemplatePayload — only true I/O boundaries mocked
 *    (global fetch for Supabase REST/RPC, sendMetaMessage and the whole
 *    _whatsapp-delivery.js bookkeeping module, both already covered by
 *    their own test suites elsewhere).
 *
 *  - "handleInboundStaffMessage" — the real function from
 *    api/whatsapp-webhook.js, proving the Phase B hook is wired at the
 *    right place and selects truthful staff-facing wording — with
 *    processStaffMessage and notifyOwnerOfEscalation mocked (both have
 *    their own dedicated correctness coverage; this layer's job is to
 *    prove the wiring between them, not re-prove their internals).
 */

// ── Layer 1: notifyOwnerOfEscalation (real implementation) ────────────────

const whatsappDeliveryMocks = vi.hoisted(() => ({
  beginWhatsappDelivery: vi.fn(async () => 'delivery-1'),
  markWhatsappDeliveryAccepted: vi.fn(async () => {}),
  markWhatsappDeliveryFailed: vi.fn(async () => {}),
  getMetaFailure: vi.fn((result) => ({
    httpStatus: result?.status ?? null,
    code: result?.metaError?.code ?? null,
    subcode: null,
    reason: result?.metaError?.message ?? 'WhatsApp delivery failed.',
  })),
}));

vi.mock('./_whatsapp-delivery.js', () => whatsappDeliveryMocks);

const sendMetaMessageMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, messageId: 'wamid.owner-1', metaError: null })));

vi.mock('./send-whatsapp-task.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMetaMessage: sendMetaMessageMock };
});

const { notifyOwnerOfEscalation } = await import('./_escalation-notify.js');

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) };
}

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-key';
const USER_A = 'owner-a';
const MSG_A = 'staff-msg-a';
const ESCALATION_A = { id: 'escalation-a', deep_link_token: 'aaaaaaaa-1111-4111-8111-111111111111', status: 'open' };

beforeEach(() => {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-access-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-number-id-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  whatsappDeliveryMocks.beginWhatsappDelivery.mockClear();
  whatsappDeliveryMocks.markWhatsappDeliveryAccepted.mockClear();
  whatsappDeliveryMocks.markWhatsappDeliveryFailed.mockClear();
  sendMetaMessageMock.mockClear();
});

describe('notifyOwnerOfEscalation — real implementation, mocked I/O boundaries', () => {
  it('[1] a fresh escalating outcome claims exactly one decision row with the correct staff_message_id/user_id/task_id', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }])) // restSelect current status
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A)) // claim_escalation_owner_decision
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse({})); // final PATCH owner_notification_status='sent'
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: 'task-1', escalationReason: 'Oven broken, needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(result.escalationId).toBe('escalation-a');
    expect(result.deepLinkToken).toBe('aaaaaaaa-1111-4111-8111-111111111111');

    const claimCall = fetchMock.mock.calls[1];
    expect(claimCall[0]).toContain('/rpc/claim_escalation_owner_decision');
    const claimBody = JSON.parse(claimCall[1].body);
    expect(claimBody).toEqual({ p_staff_message_id: MSG_A, p_user_id: USER_A, p_task_id: 'task-1' });
  });

  it('[2] calling notifyOwnerOfEscalation twice reuses the same escalation and sends Meta only once (idempotent on already-sent)', async () => {
    const fetchMock = vi.fn()
      // First call: not yet attempted -> full send path.
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({}))
      // Second call: already sent -> short-circuits before any RPC/Meta call.
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'sent' }]));
    vi.stubGlobal('fetch', fetchMock);

    const args = { staffMessageId: MSG_A, userId: USER_A, taskId: 'task-1', escalationReason: 'Oven broken', staffName: 'Christopher' };
    const first = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    const second = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });

    expect(first.status).toBe('sent');
    expect(second).toEqual({ attempted: false, status: 'sent', reason: 'already_sent' });
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(5); // 4 for the first call + 1 status check for the second
  });

  it('[3][4] owner phone found and Meta accepts: status sent, owner_notified_at set only in the acceptance PATCH', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(result.notifiedAt).toBeTruthy();

    const patchCall = fetchMock.mock.calls[3];
    expect(patchCall[1].method).toBe('PATCH');
    const patchBody = JSON.parse(patchCall[1].body);
    expect(patchBody.owner_notification_status).toBe('sent');
    expect(patchBody.owner_notified_at).toBe(result.notifiedAt);
  });

  it('[5] missing owner phone: status skipped_no_phone, no Meta call attempted, no false owner-contact claim', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone: no "boss" row
      .mockResolvedValueOnce(jsonResponse({})); // final PATCH skipped_no_phone
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('skipped_no_phone');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    const patchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(patchBody.owner_notification_status).toBe('skipped_no_phone');
    expect(patchBody.owner_notified_at).toBeUndefined();
  });

  it('[6] Meta rejects the send: status failed, no false success', async () => {
    sendMetaMessageMock.mockResolvedValueOnce({ ok: false, status: 400, metaError: { code: 131047, message: 'Re-engagement message' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('failed');
    expect(whatsappDeliveryMocks.markWhatsappDeliveryFailed).toHaveBeenCalledTimes(1);
    const patchBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(patchBody.owner_notification_status).toBe('failed');
  });

  it('[7] a thrown network error from sendMetaMessage: status failed, no false success', async () => {
    sendMetaMessageMock.mockRejectedValueOnce(new Error('fetch failed'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('network_error');
    expect(whatsappDeliveryMocks.markWhatsappDeliveryFailed).toHaveBeenCalledTimes(1);
  });

  it('[failed delivery may be explicitly retried] a prior failed attempt reuses the same escalation and can succeed on retry', async () => {
    // First attempt: not_attempted -> Meta rejects -> failed.
    sendMetaMessageMock.mockResolvedValueOnce({ ok: false, status: 500, metaError: { message: 'temporary' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({}))
      // Retry: status is now 'failed', still not 'sent' -> attempts again, claims the SAME escalation, Meta now accepts.
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'failed' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const args = { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' };
    const first = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    expect(first.status).toBe('failed');

    const retry = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    expect(retry.status).toBe('sent');
    expect(retry.escalationId).toBe(ESCALATION_A.id);
    expect(retry.deepLinkToken).toBe(ESCALATION_A.deep_link_token);

    // Both claim calls targeted the same staff_message_id — no second escalation created.
    const claimBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/rpc/claim_escalation_owner_decision'))
      .map(([, init]) => JSON.parse(init.body));
    expect(claimBodies).toHaveLength(2);
    expect(claimBodies[0].p_staff_message_id).toBe(MSG_A);
    expect(claimBodies[1].p_staff_message_id).toBe(MSG_A);
  });

  it('[12] no cross-user or cross-staff-message bleed between two independent escalations', async () => {
    const escalationB = { id: 'escalation-b', deep_link_token: 'bbbbbbbb-2222-4222-8222-222222222222', status: 'open' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse([{ owner_notification_status: 'not_attempted' }]))
      .mockResolvedValueOnce(jsonResponse(escalationB))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Grace', role: 'boss', phone: '+15550000088' }]))
      .mockResolvedValueOnce(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const resultA = await notifyOwnerOfEscalation(
      { staffMessageId: 'staff-msg-a', userId: 'owner-a', taskId: 'task-a', escalationReason: 'Issue A', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );
    const resultB = await notifyOwnerOfEscalation(
      { staffMessageId: 'staff-msg-b', userId: 'owner-b', taskId: 'task-b', escalationReason: 'Issue B', staffName: 'Nasira' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(resultA.escalationId).toBe('escalation-a');
    expect(resultB.escalationId).toBe('escalation-b');
    expect(resultA.deepLinkToken).not.toBe(resultB.deepLinkToken);

    const claimBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/rpc/claim_escalation_owner_decision'))
      .map(([, init]) => JSON.parse(init.body));
    expect(claimBodies[0]).toEqual({ p_staff_message_id: 'staff-msg-a', p_user_id: 'owner-a', p_task_id: 'task-a' });
    expect(claimBodies[1]).toEqual({ p_staff_message_id: 'staff-msg-b', p_user_id: 'owner-b', p_task_id: 'task-b' });

    const patchCalls = fetchMock.mock.calls.filter(([url, init]) => init?.method === 'PATCH');
    expect(patchCalls[0][0]).toContain('staff-msg-a');
    expect(patchCalls[1][0]).toContain('staff-msg-b');
  });
});

// ── Layer 2: handleInboundStaffMessage wiring (mocked processStaffMessage + notifyOwnerOfEscalation) ─

const staffEngineMocks = vi.hoisted(() => ({
  processStaffMessage: vi.fn(),
}));
vi.mock('./_staff-comms-engine.js', () => staffEngineMocks);

describe('handleInboundStaffMessage — Phase B hook wiring', () => {
  let handleInboundStaffMessage;
  let notifyMock;

  beforeEach(async () => {
    vi.doMock('./_escalation-notify.js', () => ({ notifyOwnerOfEscalation: vi.fn() }));
    vi.resetModules();
    ({ handleInboundStaffMessage } = await import('./whatsapp-webhook.js'));
    ({ notifyOwnerOfEscalation: notifyMock } = await import('./_escalation-notify.js'));
    staffEngineMocks.processStaffMessage.mockReset();
  });

  afterEach(() => {
    vi.doUnmock('./_escalation-notify.js');
    vi.resetModules();
  });

  function baseFetchSequence({ existingRows = [], responseDeliveryClaim = { claimed: true, claim_token: 'lease-1', response_text: 'stale-text' } } = {}) {
    // Note: sendMetaMessage itself is mocked file-wide (Layer 1's boundary,
    // via sendMetaMessageMock), so it never issues a real fetch call here —
    // only the raw Supabase REST/RPC calls below go through this mock.
    return vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ user_id: 'owner-a' }])) // whatsapp_health_state
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-a', user_id: 'owner-a', name: 'Christopher', phone: '+15551112222', role: 'staff', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-01-01T00:00:00Z', whatsapp_consent_method: 'reply' }])) // people
      .mockResolvedValueOnce(jsonResponse(existingRows)) // dedup SELECT on staff_messages
      .mockResolvedValueOnce(jsonResponse([responseDeliveryClaim])) // claim_staff_response_delivery
      .mockResolvedValue(jsonResponse({})); // complete/fail_staff_response_delivery and any further calls
  }

  it('[8] truthful staff response after a successful owner notification', async () => {
    staffEngineMocks.processStaffMessage.mockResolvedValueOnce({
      ok: true, messageId: 'staff-msg-a', response: 'I will check on this.',
      userFacingState: 'Needs You', ownerAttentionRequired: true,
      escalationReason: 'Oven broken', relatedTaskId: 'task-1', nextActionOwner: 'owner',
    });
    notifyMock.mockResolvedValueOnce({ attempted: true, status: 'sent', escalationId: 'escalation-a', deepLinkToken: 'token-1' });
    const fetchMock = baseFetchSequence();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token');

    const result = await handleInboundStaffMessage({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
      msg: { phoneNumberId: 'pnid-1', from: '15551112222', body: 'The oven is broken', messageId: 'wamid.in-1', timestamp: '1735689600' },
    });

    expect(result.handled).toBe(true);
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ staffMessageId: 'staff-msg-a', userId: 'owner-a', taskId: 'task-1', escalationReason: 'Oven broken', staffName: 'Christopher' }),
      expect.objectContaining({ supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY }),
    );
    // sendMetaMessage is mocked file-wide (Layer 1's boundary) — assert the
    // exact staff-facing payload it was called with, rather than a raw fetch.
    const [sentPayload] = sendMetaMessageMock.mock.calls.at(-1);
    expect(sentPayload.payload.text.body).toBe("I'm checking with the owner. I'll come back to you.");
  });

  it('[9] truthful staff response when the owner notification fails', async () => {
    staffEngineMocks.processStaffMessage.mockResolvedValueOnce({
      ok: true, messageId: 'staff-msg-a', response: 'I will check on this.',
      userFacingState: 'Needs You', ownerAttentionRequired: true,
      escalationReason: 'Oven broken', relatedTaskId: 'task-1', nextActionOwner: 'owner',
    });
    notifyMock.mockResolvedValueOnce({ attempted: true, status: 'failed', reason: 'meta_rejected' });
    const fetchMock = baseFetchSequence();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token');

    await handleInboundStaffMessage({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
      msg: { phoneNumberId: 'pnid-1', from: '15551112222', body: 'The oven is broken', messageId: 'wamid.in-2', timestamp: '1735689600' },
    });

    const [sentPayload] = sendMetaMessageMock.mock.calls.at(-1);
    expect(sentPayload.payload.text.body).toBe("I've recorded this for the owner, but I couldn't reach them on WhatsApp yet.");
    expect(sentPayload.payload.text.body).not.toContain('checking with the owner');
  });

  it('[10] a duplicate webhook delivery never sends a second staff-facing message', async () => {
    staffEngineMocks.processStaffMessage.mockResolvedValueOnce({
      ok: true, messageId: 'staff-msg-a', response: 'I will check on this.',
      userFacingState: 'Needs You', ownerAttentionRequired: true,
      escalationReason: 'Oven broken', relatedTaskId: 'task-1', nextActionOwner: 'owner',
    });
    notifyMock.mockResolvedValue({ attempted: false, status: 'sent', reason: 'already_sent' });

    // Second delivery: staff_messages row already completed, response delivery already claimed by the first attempt.
    const fetchMock = baseFetchSequence({
      existingRows: [{
        id: 'staff-msg-a', processing_status: 'completed', carson_response: 'I will check on this.',
        task_id: 'task-1', user_facing_state: 'Needs You', owner_attention_required: true,
        escalation_reason: 'Oven broken', next_action_owner: 'owner',
      }],
      responseDeliveryClaim: { claimed: false },
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token');

    const result = await handleInboundStaffMessage({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
      msg: { phoneNumberId: 'pnid-1', from: '15551112222', body: 'The oven is broken', messageId: 'wamid.in-1', timestamp: '1735689600' },
    });

    expect(result).toEqual({ handled: true, reason: 'already_claimed' });
    // claim_staff_response_delivery returned claimed:false, so the code path
    // must never reach sendMetaMessage at all for the second delivery.
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('[11] recovery after a crash between staff-message completion and escalation claim: retry still notifies', async () => {
    // Simulates a redelivery after the process died right after complete_staff_message
    // committed but before the Phase B hook ever ran — owner_notification_status is
    // still 'not_attempted' on the row read back from the dedup branch.
    const fetchMock = baseFetchSequence({
      existingRows: [{
        id: 'staff-msg-a', processing_status: 'completed', carson_response: 'I will check on this.',
        task_id: 'task-1', user_facing_state: 'Needs You', owner_attention_required: true,
        escalation_reason: 'Oven broken', next_action_owner: 'owner', owner_notification_status: 'not_attempted',
      }],
      responseDeliveryClaim: { claimed: true, claim_token: 'lease-1', response_text: 'stale-text' },
    });
    notifyMock.mockResolvedValueOnce({ attempted: true, status: 'sent', escalationId: 'escalation-a', deepLinkToken: 'token-1' });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token');

    await handleInboundStaffMessage({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
      msg: { phoneNumberId: 'pnid-1', from: '15551112222', body: 'The oven is broken', messageId: 'wamid.in-1', timestamp: '1735689600' },
    });

    // processStaffMessage must NOT be called again — the dedup branch was used.
    expect(staffEngineMocks.processStaffMessage).not.toHaveBeenCalled();
    // Yet the escalation hook still fired, using the widened dedup fields.
    expect(notifyMock).toHaveBeenCalledWith(
      expect.objectContaining({ staffMessageId: 'staff-msg-a', userId: 'owner-a', taskId: 'task-1', escalationReason: 'Oven broken', staffName: 'Christopher' }),
      expect.anything(),
    );
  });

  it('a non-escalating outcome (Waiting/Completed) never triggers an owner notification', async () => {
    staffEngineMocks.processStaffMessage.mockResolvedValueOnce({
      ok: true, messageId: 'staff-msg-a', response: 'Done, no issue.',
      userFacingState: 'Completed', ownerAttentionRequired: false,
      escalationReason: null, relatedTaskId: 'task-1', nextActionOwner: 'nobody',
    });
    const fetchMock = baseFetchSequence();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token');

    await handleInboundStaffMessage({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
      msg: { phoneNumberId: 'pnid-1', from: '15551112222', body: 'All good, done.', messageId: 'wamid.in-3', timestamp: '1735689600' },
    });

    expect(notifyMock).not.toHaveBeenCalled();
  });
});
