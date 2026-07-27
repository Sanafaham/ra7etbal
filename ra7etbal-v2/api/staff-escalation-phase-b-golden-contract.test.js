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
 *    api/_escalation-notify.js, calling the real claim_owner_escalation_
 *    notification / complete_.../fail_... lease RPCs, the real
 *    claim_escalation_owner_decision RPC shape, the real findOwnerPhone,
 *    the real buildOwnerDecisionTemplatePayload — only true I/O boundaries
 *    mocked (global fetch for Supabase REST/RPC, sendMetaMessage and the
 *    whole _whatsapp-delivery.js bookkeeping module, both already covered
 *    by their own test suites elsewhere).
 *
 *  - "handleInboundStaffMessage" — the real function from
 *    api/whatsapp-webhook.js, proving the Phase B hook is wired at the
 *    right place and selects truthful staff-facing wording — with
 *    processStaffMessage and notifyOwnerOfEscalation mocked (both have
 *    their own dedicated correctness coverage; this layer's job is to
 *    prove the wiring between them, not re-prove their internals).
 *
 * Post-independent-review addition (blocking defects #1/#2): the
 * check-then-act owner_notification_status read/write is replaced by an
 * atomic claim/complete/fail lease (claim_owner_escalation_notification /
 * complete_.../fail_...), and the success ordering now records the
 * persistent 'sent' state before the best-effort delivery-acceptance
 * bookkeeping. Layer 1 below includes dedicated concurrency/race tests
 * proving the client correctly respects the atomic claim's result, and a
 * deliberate-failure proof (see the end of this file's accompanying
 * commit) removing the atomic claim and showing the concurrency test then
 * fails.
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

// claim_owner_escalation_notification's RETURNS TABLE shape.
function claimResponse({ claimed, claimToken = null, status }) {
  return jsonResponse([{ message_id: MSG_A, claimed, claim_token: claimToken, notification_status: status }]);
}

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
  it('[1] a fresh escalating outcome claims the notification lease, then exactly one decision row, with correct RPC args', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' })) // claim_owner_escalation_notification
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A)) // claim_escalation_owner_decision
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:00:00.000Z' })); // complete_owner_escalation_notification
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: 'task-1', escalationReason: 'Oven broken, needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(result.escalationId).toBe('escalation-a');
    expect(result.deepLinkToken).toBe('aaaaaaaa-1111-4111-8111-111111111111');

    const claimLeaseCall = fetchMock.mock.calls[0];
    expect(claimLeaseCall[0]).toContain('/rpc/claim_owner_escalation_notification');
    expect(JSON.parse(claimLeaseCall[1].body)).toEqual({ p_id: MSG_A, p_user_id: USER_A, p_lease_seconds: 120 });

    const claimEscalationCall = fetchMock.mock.calls[1];
    expect(claimEscalationCall[0]).toContain('/rpc/claim_escalation_owner_decision');
    expect(JSON.parse(claimEscalationCall[1].body)).toEqual({ p_staff_message_id: MSG_A, p_user_id: USER_A, p_task_id: 'task-1' });

    // Audit-gap fix (2026-07-27): beginWhatsappDelivery must be called with
    // staffMessageId so it can resolve a trusted owner context for a
    // taskless escalation — see api/_whatsapp-delivery.test.js for the full
    // resolveDeliveryContext coverage; this only proves the caller wiring.
    expect(whatsappDeliveryMocks.beginWhatsappDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ staffMessageId: MSG_A }),
    );
  });

  it('[2] calling notifyOwnerOfEscalation twice sequentially sends Meta only once (idempotent on already-sent)', async () => {
    const fetchMock = vi.fn()
      // First call: not yet attempted -> full send path.
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:00:00.000Z' }))
      // Second call: the lease claim itself reports the row already sent —
      // short-circuits before any further RPC or Meta call.
      .mockResolvedValueOnce(claimResponse({ claimed: false, status: 'sent' }));
    vi.stubGlobal('fetch', fetchMock);

    const args = { staffMessageId: MSG_A, userId: USER_A, taskId: 'task-1', escalationReason: 'Oven broken', staffName: 'Christopher' };
    const first = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    const second = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });

    expect(first.status).toBe('sent');
    expect(second).toEqual({ attempted: false, status: 'sent', reason: 'already_sent' });
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(5); // 4 for the first call + 1 lease-claim check for the second
    // The already-sent short-circuit returns before beginWhatsappDelivery is
    // ever reached, so retrying after 'sent' must never attempt a second
    // audit row.
    expect(whatsappDeliveryMocks.beginWhatsappDelivery).toHaveBeenCalledTimes(1);
  });

  it('[concurrent] two overlapping calls for the same staff message result in exactly one Meta send', async () => {
    // Simulates what the real atomic claim_owner_escalation_notification
    // RPC would return for two genuinely concurrent redeliveries: only the
    // first caller's claim wins (claimed:true); the second observes the
    // row already 'sending' (claimed:false) before either has sent
    // anything — proven for real against Postgres in
    // 04_owner_notification_lease_verification.sql's scenario 2. This test
    // proves the JS client correctly respects that result and never sends
    // twice, using the deterministic ordering of two `fetch` calls sharing
    // one mock queue in a single-threaded run.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'winner-token', status: 'sending' })) // caller 1 wins the claim
      .mockResolvedValueOnce(claimResponse({ claimed: false, status: 'sending' })) // caller 2 loses — live lease
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);

    const args = { staffMessageId: MSG_A, userId: USER_A, taskId: 'task-1', escalationReason: 'Oven broken', staffName: 'Christopher' };
    const [resultA, resultB] = await Promise.all([
      notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY }),
      notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY }),
    ]);

    const statuses = [resultA.status, resultB.status].sort();
    expect(statuses).toEqual(['in_progress', 'sent']);
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
  });

  it('[in-progress] a caller that receives a live lease from another attempt never sends and never falsely reports success', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: false, status: 'sending' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: 'task-1', escalationReason: 'Oven broken', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.attempted).toBe(false);
    expect(result.status).toBe('in_progress');
    expect(result.status).not.toBe('sent');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('[3][4] owner phone found and Meta accepts: status sent, owner_notified_at set only by complete_owner_escalation_notification', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('sent');
    expect(result.notifiedAt).toBe('2026-07-27T00:00:00.000Z');

    const completeCall = fetchMock.mock.calls[3];
    expect(completeCall[0]).toContain('/rpc/complete_owner_escalation_notification');
    expect(JSON.parse(completeCall[1].body)).toEqual({ p_id: MSG_A, p_user_id: USER_A, p_claim_token: 'lease-token-1' });
  });

  it('[5] missing owner phone: status skipped_no_phone, fails the lease truthfully, no Meta call attempted', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([])) // findOwnerPhone: no "boss" row
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'failed' })); // fail_owner_escalation_notification
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('skipped_no_phone');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    const failCall = fetchMock.mock.calls[3];
    expect(failCall[0]).toContain('/rpc/fail_owner_escalation_notification');
    const failBody = JSON.parse(failCall[1].body);
    expect(failBody.p_claim_token).toBe('lease-token-1');
    expect(failBody.p_error).toBe('no_owner_phone_on_file');
  });

  it('[6] Meta rejects the send: status failed, no false success', async () => {
    sendMetaMessageMock.mockResolvedValueOnce({ ok: false, status: 400, metaError: { code: 131047, message: 'Re-engagement message' } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'failed' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('failed');
    expect(whatsappDeliveryMocks.markWhatsappDeliveryFailed).toHaveBeenCalledTimes(1);
    const failBody = JSON.parse(fetchMock.mock.calls[3][1].body);
    expect(failBody.p_error).toBe('meta_rejected');
  });

  it('[7] a thrown network error from sendMetaMessage: status failed, no false success', async () => {
    sendMetaMessageMock.mockRejectedValueOnce(new Error('fetch failed'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'failed' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('network_error');
    expect(whatsappDeliveryMocks.markWhatsappDeliveryFailed).toHaveBeenCalledTimes(1);
  });

  it('[failed retry] a prior failed attempt is explicitly retryable and can succeed on retry, reusing the same escalation', async () => {
    sendMetaMessageMock.mockResolvedValueOnce({ ok: false, status: 500, metaError: { message: 'temporary' } });
    const fetchMock = vi.fn()
      // First attempt: claim succeeds, Meta rejects -> failed.
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'failed' }))
      // Retry: the lease is claimable again from 'failed', with a fresh token; Meta now accepts.
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-2', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);

    const args = { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' };
    const first = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    expect(first.status).toBe('failed');

    const retry = await notifyOwnerOfEscalation(args, { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY });
    expect(retry.status).toBe('sent');
    expect(retry.escalationId).toBe(ESCALATION_A.id);

    // Both claim_escalation_owner_decision calls targeted the same staff_message_id — no second escalation created.
    const claimBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/rpc/claim_escalation_owner_decision'))
      .map(([, init]) => JSON.parse(init.body));
    expect(claimBodies).toHaveLength(2);
    expect(claimBodies[0].p_staff_message_id).toBe(MSG_A);
    expect(claimBodies[1].p_staff_message_id).toBe(MSG_A);

    // The retry used a fresh lease token, never the stale first one.
    const completeCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/rpc/complete_owner_escalation_notification'));
    expect(JSON.parse(completeCall[1].body).p_claim_token).toBe('lease-token-2');
  });

  it('[stale claim-lease token] complete_owner_escalation_notification rejecting a stale token is handled truthfully, not resent', async () => {
    // A real stale-token rejection from complete_owner_escalation_notification
    // only happens after Meta has already genuinely accepted the send (the
    // function is only called post-acceptance) — so the correct, truthful
    // behavior is to report 'sent' (a real message went out) while logging
    // the persistence gap, never to silently resend.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ message: 'stale_notification_claim', code: '40001' }, false));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('sent');
    expect(result.reason).toBe('sent_but_not_recorded');
  });

  it('[stale fail-lease token] fail_owner_escalation_notification rejecting a stale token never crashes the caller', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([])) // no owner phone -> triggers failLease
      .mockResolvedValueOnce(jsonResponse({ message: 'stale_notification_claim', code: '40001' }, false));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    // The stale fail-token rejection is swallowed (non-fatal, logged) —
    // the caller still gets the truthful skipped_no_phone result rather
    // than an unhandled rejection.
    expect(result.status).toBe('skipped_no_phone');
  });

  it('[bookkeeping-failure-after-sent] a markWhatsappDeliveryAccepted failure after the persistent sent state never causes a resend', async () => {
    whatsappDeliveryMocks.markWhatsappDeliveryAccepted.mockRejectedValueOnce(new Error('whatsapp_deliveries insert failed'));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-1', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:00:00.000Z' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfEscalation(
      { staffMessageId: MSG_A, userId: USER_A, taskId: null, escalationReason: 'Needs a decision', staffName: 'Christopher' },
      { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY },
    );

    // The 'sent' state was already recorded via complete_owner_escalation_notification
    // BEFORE the bookkeeping call — its failure must not change the outcome.
    expect(result.status).toBe('sent');
    expect(result.notifiedAt).toBe('2026-07-27T00:00:00.000Z');
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
  });

  it('[12] no cross-user or cross-staff-message bleed between two independent escalations', async () => {
    const escalationB = { id: 'escalation-b', deep_link_token: 'bbbbbbbb-2222-4222-8222-222222222222', status: 'open' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-a', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(ESCALATION_A))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Sana', role: 'boss', phone: '+15550000099' }]))
      .mockResolvedValueOnce(jsonResponse({ ...ESCALATION_A, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:00:00.000Z' }))
      .mockResolvedValueOnce(claimResponse({ claimed: true, claimToken: 'lease-token-b', status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse(escalationB))
      .mockResolvedValueOnce(jsonResponse([{ name: 'Grace', role: 'boss', phone: '+15550000088' }]))
      .mockResolvedValueOnce(jsonResponse({ ...escalationB, owner_notification_status: 'sent', owner_notified_at: '2026-07-27T00:01:00.000Z' }));
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

    const leaseClaimBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/rpc/claim_owner_escalation_notification'))
      .map(([, init]) => JSON.parse(init.body));
    expect(leaseClaimBodies[0]).toEqual({ p_id: 'staff-msg-a', p_user_id: 'owner-a', p_lease_seconds: 120 });
    expect(leaseClaimBodies[1]).toEqual({ p_id: 'staff-msg-b', p_user_id: 'owner-b', p_lease_seconds: 120 });

    const claimEscalationBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).includes('/rpc/claim_escalation_owner_decision'))
      .map(([, init]) => JSON.parse(init.body));
    expect(claimEscalationBodies[0]).toEqual({ p_staff_message_id: 'staff-msg-a', p_user_id: 'owner-a', p_task_id: 'task-a' });
    expect(claimEscalationBodies[1]).toEqual({ p_staff_message_id: 'staff-msg-b', p_user_id: 'owner-b', p_task_id: 'task-b' });
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

  it('[9b] truthful staff response when the owner notification is in-progress elsewhere', async () => {
    staffEngineMocks.processStaffMessage.mockResolvedValueOnce({
      ok: true, messageId: 'staff-msg-a', response: 'I will check on this.',
      userFacingState: 'Needs You', ownerAttentionRequired: true,
      escalationReason: 'Oven broken', relatedTaskId: 'task-1', nextActionOwner: 'owner',
    });
    notifyMock.mockResolvedValueOnce({ attempted: false, status: 'in_progress', reason: 'lease_held_elsewhere' });
    const fetchMock = baseFetchSequence();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token');

    await handleInboundStaffMessage({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY,
      msg: { phoneNumberId: 'pnid-1', from: '15551112222', body: 'The oven is broken', messageId: 'wamid.in-2b', timestamp: '1735689600' },
    });

    // Never a false claim of a new successful contact unless status is genuinely 'sent'.
    const [sentPayload] = sendMetaMessageMock.mock.calls.at(-1);
    expect(sentPayload.payload.text.body).not.toContain("I'm checking with the owner. I'll come back to you.");
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
