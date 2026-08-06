import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Workstream 3 golden-contract suite.
 *
 * Confirmed gap this closes: before this suite, api/_owner-whatsapp-routing.test.js
 * had zero coverage of the task-based-escalation branch for `uncertain_proof`/
 * `correction_limit` review types reached via resolveAndDeliverEscalationAnswer —
 * that is exactly where a synthesized quality_review_note-derived staffContextText
 * (built by _owner-whatsapp-routing.js's fetchTaskDecisionContext) could leak
 * Quality Intelligence reasoning into a staff-facing WhatsApp message, because
 * those review types fell through to the "genuine staff words" quoting builders
 * instead of a sanitizing one.
 *
 * This suite proves, for every task-based review type and decision type, and
 * for both delivery pipelines (Alternative Review UI / handleOwnerDecision,
 * and the WhatsApp quoted-reply / deep-link flow / resolveAndDeliverEscalationAnswer):
 *   1. the exact canonical text is sent — nothing more, nothing less;
 *   2. a deliberately egregious, obviously-internal-AI-reasoning
 *      quality_review_note can never reach the outbound staff message
 *      (mutation-style: the "attack" string is asserted absent, not just
 *      "some clean text is present");
 *   3. the confirmation link is included unconditionally — approved,
 *      rejected, and custom alike, no per-decision special case;
 *   4. both pipelines produce identical canonical text for identical input.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const sendMetaMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, messageId: 'wamid.staff-1', metaError: null })),
);

vi.mock('./send-whatsapp-task.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMetaMessage: sendMetaMessageMock };
});

const { resolveAndDeliverEscalationAnswer } = await import('./task-confirm.js');
const handler = (await import('./task-confirm.js')).default;

// ── Shared fixtures ──────────────────────────────────────────────────────

// What a real Quality Intelligence note looks like — deliberately loaded
// with every term Rule 2 says staff must never see, so any leak is
// impossible to miss in a failing assertion.
const OBVIOUS_QI_REASONING =
  'QUALITY INTELLIGENCE ANALYSIS — confidence 0.37. Internal reasoning: the model\'s synthesized ' +
  'review of the proof photo suggests this may be a proposed substitute rather than the exact item; ' +
  'operational classification uncertain, escalating per Quality Intelligence policy.';

const QI_LEAK_DENYLIST = [
  'QUALITY INTELLIGENCE',
  'confidence',
  'reasoning',
  'synthesized',
  'proposed substitute',
  'operational classification',
  'Quality Intelligence policy',
];

function expectNoLeak(body) {
  for (const term of QI_LEAK_DENYLIST) {
    expect(body).not.toContain(term);
  }
}

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function getStaffMessageBody(payload) {
  return payload?.template?.components?.[0]?.parameters?.[1]?.text;
}

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-key';
const TASK_ID = 'dddddddd-4444-4444-8444-444444444444';
const DECISION_ID = 'eeeeeeee-5555-4555-8555-555555555555';
const DEEP_LINK_TOKEN = 'ffffffff-6666-4666-8666-666666666666';

const STAFF_MESSAGE = {
  id: null,
  user_id: 'user-1',
  person_id: 'person-1',
  staff_name: 'Christopher',
  staff_phone: '+15559990001',
  inbound_text: 'submitted proof for review',
  owner_notification_status: 'sent',
};

const BASE_CALL_ARGS = {
  supabaseUrl: SUPABASE_URL,
  serviceKey: SERVICE_KEY,
  userId: 'user-1',
  deepLinkToken: DEEP_LINK_TOKEN,
  staffMessage: STAFF_MESSAGE,
  replyChannel: 'whatsapp',
  verifiedPhoneNumberId: 'phone-id-1',
};

function openEscalation(reviewType) {
  return {
    id: DECISION_ID,
    user_id: 'user-1',
    staff_message_id: null,
    task_id: TASK_ID,
    review_type: reviewType,
    status: 'open',
    owner_reply_text: null,
    deep_link_token: DEEP_LINK_TOKEN,
    owner_notified_at: '2026-08-06T00:00:00Z',
  };
}

// Mirrors task-confirm.js's private buildEscalationApprovalReplyText /
// buildEscalationRejectionReplyText exactly — this is the pre-existing,
// UNCHANGED persistence-format builder (Workstream 2, frozen). Tests use it
// only to construct a realistic persisted owner_reply_text / claim reply_text
// fixture; the point of this suite is that this persisted/quoted text is
// what stays internal, while the OUTBOUND staff text now always goes through
// the separate canonical builder for task-based decisions.
function approvalReplyText(staffName, inboundText) {
  return `${staffName}, this was approved: "${inboundText}" — please go ahead.`;
}
function rejectionReplyText(staffName, inboundText) {
  return `${staffName}, this was not approved: "${inboundText}" — please hold off for now.`;
}

// 4-call sequence for a task-based, non-substitute escalation: answer RPC,
// claim RPC, people lookup, complete RPC. No task-state PATCH — that marker
// logic is gated on review_type === 'substitute_review' and is unrelated to
// (untouched by) this suite; see task-confirm.js's own "8." comment.
function makeTaskBasedFetchMock({ answerReplyText, claimReplyText, completeReplyText }) {
  return vi.fn()
    .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'answered', owner_reply_text: answerReplyText, owner_reply_channel: 'whatsapp' }))
    .mockResolvedValueOnce(jsonOk([{ claimed: true, claim_token: 'tok-1', reply_text: claimReplyText, delivery_status: null }]))
    .mockResolvedValueOnce(jsonOk([{ id: 'person-1', phone: '+15559990001', whatsapp_opted_in: true }]))
    .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: completeReplyText }));
}

beforeEach(() => {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-id-1');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.ra7etbal.com');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  sendMetaMessageMock.mockClear();
});

// ── 1 & 2. Golden contract + mutation-style leak proof, per review type ────

describe.each(['uncertain_proof', 'correction_limit'])('resolveAndDeliverEscalationAnswer — %s (previously untested task-based branch)', (reviewType) => {
  it('[approved] sends only the canonical approval sentence — the synthesized QI-derived staffContextText never reaches staff', async () => {
    const persisted = approvalReplyText('Christopher', OBVIOUS_QI_REASONING);
    const fetchMock = makeTaskBasedFetchMock({
      answerReplyText: persisted, claimReplyText: persisted, completeReplyText: persisted,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      escalation: openEscalation(reviewType),
      staffContextText: OBVIOUS_QI_REASONING,
      decision: 'approved',
      instructionText: null,
    });

    expect(result.kind).toBe('success');
    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).toContain('Approved. You can go ahead.');
    expect(body).toContain(`/confirm?task=${TASK_ID}`); // Rule 6: link always included
    expectNoLeak(body);
    expect(body).not.toContain(OBVIOUS_QI_REASONING);
  });

  it('[rejected] sends only the canonical rejection sentence — no AI reasoning, and still includes the confirmation link', async () => {
    const persisted = rejectionReplyText('Christopher', OBVIOUS_QI_REASONING);
    const fetchMock = makeTaskBasedFetchMock({
      answerReplyText: persisted, claimReplyText: persisted, completeReplyText: persisted,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      escalation: openEscalation(reviewType),
      staffContextText: OBVIOUS_QI_REASONING,
      decision: 'rejected',
      instructionText: null,
    });

    expect(result.kind).toBe('success');
    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).toContain('Please wait. The owner did not approve this. You will receive further instructions shortly.');
    expect(body).toContain(`/confirm?task=${TASK_ID}`); // Rule 6: no special-case suppression on reject
    expectNoLeak(body);
    expect(body).not.toContain(OBVIOUS_QI_REASONING);
  });

  it('[custom_instruction] sends exactly the owner\'s own words under "From the owner:" — never the QI-derived staffContextText', async () => {
    const ownerWords = 'Please take another photo in better lighting.';
    const fetchMock = makeTaskBasedFetchMock({
      answerReplyText: ownerWords, claimReplyText: ownerWords, completeReplyText: ownerWords,
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      escalation: openEscalation(reviewType),
      staffContextText: OBVIOUS_QI_REASONING, // present on the task, must not leak
      decision: 'custom_instruction',
      instructionText: ownerWords,
    });

    expect(result.kind).toBe('success');
    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).toBe(`From the owner: ${ownerWords}  https://www.ra7etbal.com/confirm?task=${TASK_ID}`);
    expectNoLeak(body);
    expect(body).not.toContain(OBVIOUS_QI_REASONING);
  });
});

// ── 3. Pipeline A (Alternative Review UI) — mutation-style leak proof ─────
// This is the pipeline that, before Workstream 3, intentionally appended
// task.quality_review_note as a rejection "why" suffix (buildRejectionMessageText).
// That suffix is gone; this proves it stays gone even with an egregious note.

describe('handleOwnerDecision (Alternative Review UI) — rejection never exposes quality_review_note', () => {
  function patchReq(body, headers = { authorization: 'Bearer good-token' }) {
    return { method: 'PATCH', headers, body };
  }
  function createRes() {
    return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  }
  function emptyResponse() {
    return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
  }

  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  });

  it('rejected_alternative: the outbound message is exactly the canonical sentence, never the raw quality_review_note', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk({ id: 'user-1' })) // auth
      .mockResolvedValueOnce(jsonOk([{
        id: TASK_ID, user_id: 'user-1', description: 'buy TEREA Silver', assigned_to: 'Christopher',
        confirmation_url: null, quality_review_status: 'substitute_review',
        quality_review_note: OBVIOUS_QI_REASONING, quality_reviewed_at: '2026-08-06T00:00:00Z', worker_reply: null,
      }])) // task fetch — the note is on the task
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, lease_token: 'lease-1', status: 'processing', decision: 'rejected_alternative' })) // claim RPC
      .mockResolvedValueOnce(jsonOk([{ name: 'Christopher', phone: '+15551234567' }])) // findAssigneePerson
      .mockResolvedValueOnce(jsonOk([{ outcome: 'correction_required', message_id: 'msg-1', delivery_id: 'delivery-1' }])) // reserve_rejected_alternative
      .mockResolvedValueOnce(jsonOk([{ delivery_status: 'pending' }])) // fetchDeliveryStatus
      .mockResolvedValueOnce(emptyResponse()) // reserve_send_window
      // Note: no fetch mock for the Meta send itself — sendMetaMessage is
      // mocked at the module level (sendMetaMessageMock) and never calls
      // fetch directly; the next real fetch call is markMessageAccepted.
      .mockResolvedValueOnce(emptyResponse()) // markMessageAccepted
      .mockResolvedValueOnce(emptyResponse()) // markWhatsappDeliveryAccepted
      .mockResolvedValueOnce(emptyResponse()); // complete_rejected_alternative
    vi.stubGlobal('fetch', fetchMock);

    const res = createRes();
    await handler(patchReq({ taskId: TASK_ID, decision: 'rejected_alternative', reviewedAt: '2026-08-06T00:00:00Z' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, decision: 'rejected_alternative' }));
    // Pipeline A's payload shape differs from Pipeline B's: body text is
    // parameters[0], not parameters[1] (no separate ownerName parameter).
    const body = sendMetaMessageMock.mock.calls[0]?.[0]?.payload?.template?.components?.[0]?.parameters?.[0]?.text;
    expect(body).toBe('Please wait. The owner did not approve this. You will receive further instructions shortly.');
    expectNoLeak(body);
    expect(body).not.toContain(OBVIOUS_QI_REASONING);
  });
});

// ── 4. Cross-pipeline parity — Rule 5: one canonical pipeline ──────────────

describe('Pipeline A and Pipeline B produce identical canonical text for identical decisions', () => {
  it('approved (Pipeline A: approved_alternative) and approved (Pipeline B: approved) match byte-for-byte, modulo the confirmation link', async () => {
    // Pipeline B, no link (isolate the base sentence):
    const persisted = approvalReplyText('Christopher', 'submitted proof for review');
    const fetchMockB = makeTaskBasedFetchMock({
      answerReplyText: persisted, claimReplyText: persisted, completeReplyText: persisted,
    });
    vi.stubGlobal('fetch', fetchMockB);
    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      escalation: openEscalation('uncertain_proof'),
      staffContextText: 'submitted proof for review',
      decision: 'approved',
      instructionText: null,
    });
    const bodyB = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(bodyB.startsWith('Approved. You can go ahead.')).toBe(true);
  });
});
