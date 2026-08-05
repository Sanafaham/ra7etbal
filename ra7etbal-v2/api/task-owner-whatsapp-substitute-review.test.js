import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression contract for the substitute-review WhatsApp approval path:
 *
 * 1. normalizeSubstituteDecisionReply classifies owner replies correctly.
 * 2. resolveAndDeliverEscalationAnswer for substitute_review:
 *    - updates task quality_review_status (approved or correction_required)
 *    - sends Christopher a synthesized instruction, not the raw owner reply
 *    - includes the confirmation link for approved decisions
 *    - never duplicates sends
 * 3. buildSubstituteDecisionMessageForStaff produces the correct text.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

const sendMetaMessageMock = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true, messageId: 'wamid.staff-1', metaError: null })),
);

vi.mock('./send-whatsapp-task.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMetaMessage: sendMetaMessageMock };
});

const {
  normalizeSubstituteDecisionReply,
} = await import('./_owner-whatsapp-routing.js');

const {
  resolveAndDeliverEscalationAnswer,
  buildSubstituteDecisionMessageForStaff,
} = await import('./task-confirm.js');

// ── Helpers ────────────────────────────────────────────────────────────────

// Staff messages now use buildDirectMessagePayload (template), not plain text.
// The message body is the second body parameter ({{2}} = message text).
function getStaffMessageBody(payload) {
  return payload?.template?.components?.[0]?.parameters?.[1]?.text;
}

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-key';
const TASK_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const DECISION_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const DEEP_LINK_TOKEN = 'cccccccc-3333-4333-8333-333333333333';

const OPEN_ESCALATION = {
  id: DECISION_ID,
  user_id: 'user-1',
  staff_message_id: null,
  task_id: TASK_ID,
  review_type: 'substitute_review',
  status: 'open',
  owner_reply_text: null,
  deep_link_token: DEEP_LINK_TOKEN,
  owner_notified_at: '2026-08-01T23:09:38Z',
};

const STAFF_MESSAGE = {
  id: null,
  user_id: 'user-1',
  person_id: 'person-christopher-1',
  staff_name: 'Christopher',
  staff_phone: '+15559990001',
  inbound_text: 'proposed substitute: TEREA Turquoise for TEREA Silver',
  owner_notification_status: 'sent',
};

function jsonOk(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}
function jsonErr(body, status = 400) {
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function makeFetchMock({
  answerDecision = { id: DECISION_ID, status: 'answered', owner_reply_text: 'Yes buy it', owner_reply_channel: 'whatsapp' },
  claimResult = { claimed: true, claim_token: 'tok-1', reply_text: 'Yes buy it', delivery_status: null },
  completeResult = { id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: 'Yes buy it' },
  personOptedIn = true,
  taskPatchOk = true,
} = {}) {
  const personRow = [{ id: 'person-christopher-1', phone: '+15559990001', whatsapp_opted_in: personOptedIn }];
  return vi.fn()
    .mockResolvedValueOnce(jsonOk(answerDecision))    // answer_escalation_owner_decision
    .mockResolvedValueOnce(jsonOk([claimResult]))     // claim_escalation_answer_delivery
    .mockResolvedValueOnce(jsonOk(personRow))         // people lookup (phone/opt-in)
    .mockResolvedValueOnce(jsonOk(completeResult))    // complete_escalation_answer_delivery
    .mockResolvedValueOnce(                           // PATCH tasks (markApprovedAlternativeConfirmationOnly or rejection)
      taskPatchOk ? { ok: true, status: 204, json: async () => ({}), text: async () => '' } : jsonErr({})
    );
}

const BASE_CALL_ARGS = {
  supabaseUrl: SUPABASE_URL,
  serviceKey: SERVICE_KEY,
  userId: 'user-1',
  deepLinkToken: DEEP_LINK_TOKEN,
  escalation: OPEN_ESCALATION,
  staffMessage: STAFF_MESSAGE,
  staffContextText: 'proposed substitute: TEREA Turquoise for TEREA Silver',
  replyChannel: 'whatsapp',
  verifiedPhoneNumberId: 'phone-id-1',
};

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

// ── 1. normalizeSubstituteDecisionReply ───────────────────────────────────

describe('normalizeSubstituteDecisionReply — approval signals', () => {
  it.each([
    ['Yes', 'approved_alternative'],
    ['yes', 'approved_alternative'],
    ['Yes buy it', 'approved_alternative'],
    ['yes buy it', 'approved_alternative'],
    ['Buy it', 'approved_alternative'],
    ['buy it', 'approved_alternative'],
    ['Go ahead', 'approved_alternative'],
    ['go ahead', 'approved_alternative'],
    ['Go for it', 'approved_alternative'],
    ['That\'s fine', 'approved_alternative'],
    ['Sure', 'approved_alternative'],
    ['OK', 'approved_alternative'],
    ['Okay', 'approved_alternative'],
    ['Fine', 'approved_alternative'],
    ['Approved', 'approved_alternative'],
    ['Sounds good', 'approved_alternative'],
    ['Proceed', 'approved_alternative'],
    ['Do it', 'approved_alternative'],
    // With trailing punctuation
    ['Yes.', 'approved_alternative'],
    ['Yes!', 'approved_alternative'],
    ['Go ahead.', 'approved_alternative'],
  ])('"%s" → approved_alternative', (input, expected) => {
    const result = normalizeSubstituteDecisionReply(input);
    expect(result.decision).toBe(expected);
    expect(result.instructionText).toBe(input.trim());
  });
});

describe('normalizeSubstituteDecisionReply — rejection signals', () => {
  it.each([
    ['No', 'rejected_alternative'],
    ['no', 'rejected_alternative'],
    ['Don\'t', 'rejected_alternative'],
    ['Don\'t buy it', 'rejected_alternative'],
    ['Do not buy it', 'rejected_alternative'],
    ['Reject it', 'rejected_alternative'],
    ['Rejected', 'rejected_alternative'],
    ['Skip it', 'rejected_alternative'],
    ['Pass', 'rejected_alternative'],
    ['Nope', 'rejected_alternative'],
    // With trailing punctuation
    ['No.', 'rejected_alternative'],
    ['No!', 'rejected_alternative'],
  ])('"%s" → rejected_alternative', (input, expected) => {
    const result = normalizeSubstituteDecisionReply(input);
    expect(result.decision).toBe(expected);
    expect(result.instructionText).toBe(input.trim());
  });
});

describe('normalizeSubstituteDecisionReply — custom instruction signals', () => {
  it.each([
    ['Buy the Turquoise instead'],
    ['Get the other flavour'],
    ['Ask Christopher to check the price first'],
    ['Wait until I get home'],
    ['Only if it\'s the same price'],
  ])('"%s" → custom_instruction', (input) => {
    const result = normalizeSubstituteDecisionReply(input);
    expect(result.decision).toBe('custom_instruction');
    expect(result.instructionText).toBe(input.trim());
  });
});

it('preserves the owner\'s original text in instructionText regardless of decision', () => {
  expect(normalizeSubstituteDecisionReply('Yes buy it').instructionText).toBe('Yes buy it');
  expect(normalizeSubstituteDecisionReply('No.').instructionText).toBe('No.');
  expect(normalizeSubstituteDecisionReply('Buy the Turquoise instead').instructionText).toBe('Buy the Turquoise instead');
});

// ── 2. buildSubstituteDecisionMessageForStaff ─────────────────────────────

describe('buildSubstituteDecisionMessageForStaff', () => {
  it('approved_alternative without link → "Approved. You can go ahead with this task."', () => {
    const msg = buildSubstituteDecisionMessageForStaff({
      decision: 'approved_alternative',
      instructionText: 'Yes buy it',
      confirmationUrl: null,
    });
    expect(msg).toBe('Approved. You can go ahead with this task.');
  });

  it('approved_alternative with link → includes confirmation URL', () => {
    const msg = buildSubstituteDecisionMessageForStaff({
      decision: 'approved_alternative',
      instructionText: 'Yes',
      confirmationUrl: 'https://app.ra7etbal.com/confirm?task=abc',
    });
    expect(msg).toContain('Approved. You can go ahead with this task.');
    expect(msg).toContain('https://app.ra7etbal.com/confirm?task=abc');
  });

  it('rejected_alternative → "Do not continue…" without link', () => {
    const msg = buildSubstituteDecisionMessageForStaff({
      decision: 'rejected_alternative',
      instructionText: 'No',
      confirmationUrl: 'https://app.ra7etbal.com/confirm?task=abc', // should be ignored
    });
    expect(msg).toBe('Do not continue with this task. Please wait for further instructions.');
    expect(msg).not.toContain('https://');
  });

  it('custom_instruction → "From the owner: [text]"', () => {
    const msg = buildSubstituteDecisionMessageForStaff({
      decision: 'custom_instruction',
      instructionText: 'Buy the Turquoise instead',
      confirmationUrl: null,
    });
    expect(msg).toBe('From the owner: Buy the Turquoise instead');
  });

  it('custom_instruction with link → includes confirmation URL', () => {
    const msg = buildSubstituteDecisionMessageForStaff({
      decision: 'custom_instruction',
      instructionText: 'Buy the Turquoise instead',
      confirmationUrl: 'https://app.ra7etbal.com/confirm?task=abc',
    });
    expect(msg).toContain('From the owner: Buy the Turquoise instead');
    expect(msg).toContain('https://app.ra7etbal.com/confirm?task=abc');
  });
});

// ── 3. resolveAndDeliverEscalationAnswer — task state updates ─────────────

describe('resolveAndDeliverEscalationAnswer for substitute_review', () => {
  it('[approved_alternative] updates task to approved state and sends synthesized message', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'approved_alternative',
      instructionText: 'Yes buy it',
    });

    expect(result.kind).toBe('success');
    expect(result.status).toBe('delivered');

    // Task PATCH call must have been made (5th fetch call) to set quality_review_status = approved
    const taskPatch = fetchMock.mock.calls[4];
    expect(taskPatch[0]).toContain(`tasks?id=eq.${TASK_ID}`);
    expect(JSON.parse(taskPatch[1].body).quality_review_status).toBe('approved');
  });

  it('[approved_alternative] Christopher receives "Approved. You can go ahead..." not the raw reply', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'approved_alternative',
      instructionText: 'Yes buy it',
    });

    const sentPayload = sendMetaMessageMock.mock.calls[0]?.[0]?.payload;
    expect(getStaffMessageBody(sentPayload)).toContain('Approved. You can go ahead with this task.');
    expect(getStaffMessageBody(sentPayload)).not.toBe('Yes buy it');
  });

  it('[approved_alternative] Christopher\'s message includes the confirmation link', async () => {
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'approved_alternative',
      instructionText: 'Yes',
    });

    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).toContain(`/confirm?task=${TASK_ID}`);
  });

  it('regression (2026-08-02): template param sent to Meta has no newline or tab characters', async () => {
    // Meta rejects template parameters containing \n or \t with:
    // "Param text cannot have new-line/tab characters or more than 4 consecutive spaces"
    const fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'approved_alternative',
      instructionText: 'Yes buy it',
    });

    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).not.toMatch(/[\n\t]/);
    expect(body).not.toMatch(/ {5,}/);
    expect(body).toContain('Approved. You can go ahead with this task.');
    expect(body).toContain(`/confirm?task=${TASK_ID}`);
  });

  it('[rejected_alternative] updates task to correction_required and sends rejection message', async () => {
    const rejectFetch = vi.fn()
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'answered', owner_reply_text: 'No', owner_reply_channel: 'whatsapp' }))
      .mockResolvedValueOnce(jsonOk([{ claimed: true, claim_token: 'tok-2', reply_text: 'No', delivery_status: null }]))
      .mockResolvedValueOnce(jsonOk([{ id: 'person-christopher-1', phone: '+15559990001', whatsapp_opted_in: true }]))
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: 'No' }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => '' }); // PATCH correction_required
    vi.stubGlobal('fetch', rejectFetch);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'rejected_alternative',
      instructionText: 'No',
    });

    expect(result.kind).toBe('success');

    // Task PATCH must set correction_required
    const taskPatch = rejectFetch.mock.calls[4];
    expect(taskPatch[0]).toContain(`tasks?id=eq.${TASK_ID}`);
    expect(JSON.parse(taskPatch[1].body).quality_review_status).toBe('correction_required');

    // Christopher's message
    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).toContain('Do not continue with this task');
    expect(body).not.toContain('/confirm?task=');
  });

  it('[rejected_alternative] does not include confirmation link in Christopher\'s message', async () => {
    const rejectFetch = vi.fn()
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'answered', owner_reply_text: 'No', owner_reply_channel: 'whatsapp' }))
      .mockResolvedValueOnce(jsonOk([{ claimed: true, claim_token: 'tok-3', reply_text: 'No', delivery_status: null }]))
      .mockResolvedValueOnce(jsonOk([{ id: 'person-christopher-1', phone: '+15559990001', whatsapp_opted_in: true }]))
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: 'No' }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', rejectFetch);

    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'rejected_alternative',
      instructionText: 'No',
    });

    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).not.toContain('/confirm?task=');
  });

  it('[custom_instruction] updates task to approved state', async () => {
    const customFetch = vi.fn()
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'answered', owner_reply_text: 'Buy the Turquoise instead', owner_reply_channel: 'whatsapp' }))
      .mockResolvedValueOnce(jsonOk([{ claimed: true, claim_token: 'tok-4', reply_text: 'Buy the Turquoise instead', delivery_status: null }]))
      .mockResolvedValueOnce(jsonOk([{ id: 'person-christopher-1', phone: '+15559990001', whatsapp_opted_in: true }]))
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: 'Buy the Turquoise instead' }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', customFetch);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'custom_instruction',
      instructionText: 'Buy the Turquoise instead',
    });

    expect(result.kind).toBe('success');

    const taskPatch = customFetch.mock.calls[4];
    expect(JSON.parse(taskPatch[1].body).quality_review_status).toBe('approved');
  });

  it('[custom_instruction] Christopher receives "From the owner: [text]"', async () => {
    const customFetch = vi.fn()
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'answered', owner_reply_text: 'Buy the Turquoise instead', owner_reply_channel: 'whatsapp' }))
      .mockResolvedValueOnce(jsonOk([{ claimed: true, claim_token: 'tok-5', reply_text: 'Buy the Turquoise instead', delivery_status: null }]))
      .mockResolvedValueOnce(jsonOk([{ id: 'person-christopher-1', phone: '+15559990001', whatsapp_opted_in: true }]))
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: 'Buy the Turquoise instead' }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', customFetch);

    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'custom_instruction',
      instructionText: 'Buy the Turquoise instead',
    });

    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).toContain('From the owner: Buy the Turquoise instead');
    expect(body).toContain(`/confirm?task=${TASK_ID}`);
  });

  it('[custom_instruction] renders "tell them" as an instruction to the validated staff recipient', async () => {
    const persistedReply = 'Tell them to prepare steaks and French fries.';
    const customFetch = vi.fn()
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'answered', owner_reply_text: persistedReply, owner_reply_channel: 'whatsapp' }))
      .mockResolvedValueOnce(jsonOk([{ claimed: true, claim_token: 'tok-them', reply_text: persistedReply, delivery_status: null }]))
      .mockResolvedValueOnce(jsonOk([{ id: 'person-christopher-1', phone: '+15559990001', whatsapp_opted_in: true }]))
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: persistedReply }))
      .mockResolvedValueOnce({ ok: true, status: 204, json: async () => ({}), text: async () => '' });
    vi.stubGlobal('fetch', customFetch);

    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'custom_instruction',
      instructionText: persistedReply,
    });

    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    expect(body).toContain('From the owner: prepare steaks and French fries.');
    expect(body).not.toMatch(/tell them/i);
  });

  it('already delivered: skips task state update and sends nothing', async () => {
    const alreadyDeliveredFetch = vi.fn()
      .mockResolvedValueOnce(jsonOk({
        id: DECISION_ID, status: 'delivered_to_staff',
        owner_reply_text: 'Yes buy it', owner_reply_channel: 'whatsapp',
      })); // answer_escalation_owner_decision returns already-delivered
    vi.stubGlobal('fetch', alreadyDeliveredFetch);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'approved_alternative',
      instructionText: 'Yes buy it',
    });

    // Already delivered — returns success immediately without sending
    expect(result.kind).toBe('success');
    expect(result.status).toBe('delivered');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    // No task PATCH either
    expect(alreadyDeliveredFetch).toHaveBeenCalledTimes(1);
  });

  it('task state update failure is non-fatal — delivery is still reported as success', async () => {
    const failPatchFetch = makeFetchMock({ taskPatchOk: false });
    vi.stubGlobal('fetch', failPatchFetch);

    const result = await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      decision: 'approved_alternative',
      instructionText: 'Yes',
    });

    // Delivery succeeded even though the PATCH failed
    expect(result.kind).toBe('success');
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
  });

  it('non-substitute escalation uses normalizeOwnerReplyForRecipient, not substitute message builder', async () => {
    const standardEscalation = {
      ...OPEN_ESCALATION,
      review_type: null,
      task_id: null,
      staff_message_id: 'staff-msg-1',
    };
    const standardFetch = vi.fn()
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'answered', owner_reply_text: 'Approved. Please go ahead.', owner_reply_channel: 'whatsapp' }))
      .mockResolvedValueOnce(jsonOk([{ claimed: true, claim_token: 'tok-6', reply_text: 'Approved. Please go ahead.', delivery_status: null }]))
      .mockResolvedValueOnce(jsonOk([{ id: 'person-christopher-1', phone: '+15559990001', whatsapp_opted_in: true }]))
      .mockResolvedValueOnce(jsonOk({ id: DECISION_ID, status: 'delivered_to_staff', owner_reply_text: 'Approved. Please go ahead.' }));
    vi.stubGlobal('fetch', standardFetch);

    await resolveAndDeliverEscalationAnswer({
      ...BASE_CALL_ARGS,
      escalation: standardEscalation,
      decision: 'approved',
      instructionText: null,
    });

    const body = getStaffMessageBody(sendMetaMessageMock.mock.calls[0]?.[0]?.payload);
    // Standard path: normalizeOwnerReplyForRecipient applied, not the substitute builder
    expect(body).toBeTruthy();
    expect(body).not.toContain('Approved. You can go ahead with this task.');
    // No task PATCH
    expect(standardFetch).toHaveBeenCalledTimes(4);
  });
});
