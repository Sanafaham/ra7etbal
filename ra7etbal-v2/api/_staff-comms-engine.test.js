import { afterEach, describe, expect, it, vi } from 'vitest';
import { processStaffMessage, parseClassificationResponse, buildContextBlock, SYSTEM_PROMPT } from './_staff-comms-engine.js';

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-key';
const ANTHROPIC_KEY = 'anthropic-key';
const USER_ID = 'owner-1';
const PERSON_ID = 'person-1';
const OTHER_USER_ID = 'owner-2';

afterEach(() => {
  vi.restoreAllMocks();
});

function anthropicJsonResponse(obj) {
  return jsonResponse({ content: [{ text: JSON.stringify(obj) }] });
}

function jsonResponse(body, status = 200) {
  return { ok: status < 300, status, json: async () => body };
}

/**
 * Builds a fetch mock dispatching by URL path + method. `routes` maps a
 * `${method} ${pathAndQueryPrefix}` string to a response (or a function
 * returning one, invoked with the parsed request body).
 */
function mockFetch(routes) {
  const calls = [];
  const fn = vi.fn(async (url, options = {}) => {
    const method = options.method || 'GET';
    const u = new URL(String(url));
    const key = `${method} ${u.pathname}`;
    calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });

    const handler = routes[key];
    if (!handler) throw new Error(`No mock route for ${key} (full url: ${url})`);
    return typeof handler === 'function' ? handler(calls[calls.length - 1]) : handler;
  });
  fn.calls = calls;
  return fn;
}

function baseInput(overrides = {}) {
  return {
    userId: USER_ID,
    personId: PERSON_ID,
    text: 'Test message',
    taskId: null,
    threadId: null,
    receivedAt: '2026-07-20T10:00:00.000Z',
    source: 'simulated',
    externalMessageId: null,
    ...overrides,
  };
}

function deps(fetchImpl) {
  return { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, anthropicApiKey: ANTHROPIC_KEY, fetchImpl };
}

describe('processStaffMessage', () => {
  it('1. answers a routine question directly from context, no escalation, correct identity, state persisted', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-1', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Grace', role: 'Housekeeper', responsibilities: null, delegation_guidance: 'Cream flowers are an approved substitute for white.', should_not_assign: null, reliability_level: 'high', communication_style: null, notes: null }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'routine_question',
        reply_to_staff: 'Yes, please use the cream flowers.',
        escalate: false,
        escalation_reason: null,
        recommended_option: null,
        next_action_owner: 'nobody',
        user_facing_state: 'Completed',
        owner_attention_required: false,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse({
        id: 'msg-1', classification: 'routine_question', carson_response: 'Yes, please use the cream flowers.',
        next_action_owner: 'nobody', user_facing_state: 'Completed', owner_attention_required: false,
        escalation_reason: null, task_id: null,
      }),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'There are no white flowers. Can I use cream?' }),
      deps(fetchImpl),
    );

    expect(result.ok).toBe(true);
    expect(result.classification).toBe('routine_question');
    expect(result.ownerAttentionRequired).toBe(false);
    expect(result.nextActionOwner).toBe('nobody');
    expect(result.userFacingState).toBe('Completed');
    expect(result.response).toContain('cream flowers');

    const claimCall = fetchImpl.calls.find((c) => c.url.includes('claim_staff_message'));
    expect(claimCall.body.p_person_id).toBe(PERSON_ID);
    expect(claimCall.body.p_user_id).toBe(USER_ID);
  });

  it('2. marks a valid completion signal Completed, without any duplicate completion action', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-2', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Nasira', role: 'Cook' }]),
      'GET /rest/v1/tasks': jsonResponse([
        { id: 'task-1', type: 'delegation', description: 'Prepare lunch', assigned_to: 'Nasira', status: 'pending', due_at: null, worker_reply: null, quality_review_status: null },
      ]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'completion_confirmation',
        reply_to_staff: 'Thank you, noted.',
        escalate: false,
        escalation_reason: null,
        recommended_option: null,
        next_action_owner: 'nobody',
        user_facing_state: 'Completed',
        owner_attention_required: false,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-2', classification: 'completion_confirmation', carson_response: 'Thank you, noted.',
          next_action_owner: 'nobody', user_facing_state: 'Completed', owner_attention_required: false,
          escalation_reason: null, task_id: 'task-1',
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'Lunch is ready.', taskId: 'task-1' }),
      deps(fetchImpl),
    );

    expect(result.userFacingState).toBe('Completed');
    expect(result.classification).toBe('completion_confirmation');

    // This engine never mutates public.tasks directly — completion only
    // reflects the staff_messages row's own state.
    const taskWrites = fetchImpl.calls.filter((c) => c.url.includes('/rest/v1/tasks') && c.method !== 'GET');
    expect(taskWrites).toHaveLength(0);
  });

  it('3. answers an approved harmless substitution directly without interrupting the owner', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-3', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Christopher', role: 'Chef' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([{ rules: 'Blueberries are an approved substitute for strawberries in any recipe.' }]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'substitution_request',
        reply_to_staff: 'Yes, blueberries are fine.',
        escalate: false,
        escalation_reason: null,
        recommended_option: null,
        next_action_owner: 'nobody',
        user_facing_state: 'Completed',
        owner_attention_required: false,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-3', classification: 'substitution_request', carson_response: 'Yes, blueberries are fine.',
          next_action_owner: 'nobody', user_facing_state: 'Completed', owner_attention_required: false,
          escalation_reason: null, task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'We are out of strawberries. Can I use blueberries?' }),
      deps(fetchImpl),
    );

    expect(result.classification).toBe('substitution_request');
    expect(result.ownerAttentionRequired).toBe(false);
    expect(result.nextActionOwner).not.toBe('owner');
  });

  it('4. escalates an unknown/material change with Needs You, owner ownership, and the exact decision stated', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-4', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Ghulam', role: 'Driver' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'owner_decision_required',
        reply_to_staff: "I'm checking that with the owner, I'll come back to you.",
        escalate: true,
        escalation_reason: 'Ghulam reports the airport pickup guest count changed from 2 to 5 — needs a bigger car. Decision needed: approve upgrading to the larger vehicle.',
        recommended_option: 'Approve the larger vehicle given the guest count increase.',
        next_action_owner: 'owner',
        user_facing_state: 'Needs You',
        owner_attention_required: true,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-4', classification: 'owner_decision_required',
          carson_response: "I'm checking that with the owner, I'll come back to you.",
          next_action_owner: 'owner', user_facing_state: 'Needs You', owner_attention_required: true,
          escalation_reason: 'Ghulam reports the airport pickup guest count changed from 2 to 5 — needs a bigger car. Decision needed: approve upgrading to the larger vehicle.',
          task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'The guest count changed from 2 to 5 for the airport pickup, we need a bigger car.' }),
      deps(fetchImpl),
    );

    expect(result.nextActionOwner).toBe('owner');
    expect(result.userFacingState).toBe('Needs You');
    expect(result.ownerAttentionRequired).toBe(true);
    expect(result.escalationReason).toMatch(/decision needed/i);
  });

  it('5. asks one clarification question for an unclear message without inventing context', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-5', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Grace', role: 'Housekeeper' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'unclear',
        reply_to_staff: 'Which room are you asking about?',
        escalate: false,
        escalation_reason: null,
        recommended_option: null,
        next_action_owner: 'staff',
        user_facing_state: 'Waiting',
        owner_attention_required: false,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-5', classification: 'unclear', carson_response: 'Which room are you asking about?',
          next_action_owner: 'staff', user_facing_state: 'Waiting', owner_attention_required: false,
          escalation_reason: null, task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(baseInput({ text: 'done' }), deps(fetchImpl));

    expect(result.classification).toBe('unclear');
    expect(result.ownerAttentionRequired).toBe(false);
    expect(result.response).toMatch(/\?/); // a real clarification question, not an invented answer
  });

  it('6. rejects a cross-household claim with no data leakage and no record attached to the wrong household', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse({ message: 'not_authorized', code: '28000' }, 400),
    });

    const result = await processStaffMessage(
      baseInput({ userId: OTHER_USER_ID, personId: PERSON_ID }), // person belongs to USER_ID's household, not OTHER_USER_ID
      deps(fetchImpl),
    );

    expect(result.ok).toBe(false);
    expect(result.rejected).toBe(true);
    expect(result.rejectionReason).toBe('not_authorized');
    expect(result.messageId).toBeNull();

    // No context load, no Claude call, no completion write — the rejection
    // happened entirely inside the atomic claim, nothing else ran.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toContain('claim_staff_message');
  });

  it('7. returns the same stored outcome for a duplicate inbound message with no repeated side effect', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-7', is_new: false, processing_status: 'completed' },
      ]),
      'GET /rest/v1/staff_messages': jsonResponse([
        {
          id: 'msg-7', classification: 'routine_question', carson_response: 'Already answered once.',
          next_action_owner: 'nobody', user_facing_state: 'Completed', owner_attention_required: false,
          escalation_reason: null, task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'Same message again', externalMessageId: 'dup-external-id' }),
      deps(fetchImpl),
    );

    expect(result.duplicate).toBe(true);
    expect(result.response).toBe('Already answered once.');
    expect(result.messageId).toBe('msg-7');

    // No Claude call, no completion RPC call — a duplicate is read-only.
    const anthropicCalls = fetchImpl.calls.filter((c) => c.url.includes('api.anthropic.com'));
    const completeCalls = fetchImpl.calls.filter((c) => c.url.includes('complete_staff_message'));
    expect(anthropicCalls).toHaveLength(0);
    expect(completeCalls).toHaveLength(0);
  });

  it('8. reports a non-completion task update as In Progress or Waiting, never Completed', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-8', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Ghulam', role: 'Driver' }]),
      'GET /rest/v1/tasks': jsonResponse([
        { id: 'task-2', type: 'delegation', description: 'Airport pickup', assigned_to: 'Ghulam', status: 'pending', due_at: null, worker_reply: null, quality_review_status: null },
      ]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'task_update',
        reply_to_staff: 'Got it, thanks for the update.',
        escalate: false,
        escalation_reason: null,
        recommended_option: null,
        next_action_owner: 'staff',
        user_facing_state: 'Waiting',
        owner_attention_required: false,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-8', classification: 'task_update', carson_response: 'Got it, thanks for the update.',
          next_action_owner: 'staff', user_facing_state: 'Waiting', owner_attention_required: false,
          escalation_reason: null, task_id: 'task-2',
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'Lunch will be twenty minutes late.', taskId: 'task-2' }),
      deps(fetchImpl),
    );

    expect(result.classification).toBe('task_update');
    expect(['In Progress', 'Waiting']).toContain(result.userFacingState);
    expect(result.userFacingState).not.toBe('Completed');
  });

  it('marks the message failed (not a fabricated success) when the Claude call errors, and never calls complete_staff_message', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-9', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Grace', role: 'Housekeeper' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': jsonResponse({ error: { message: 'overloaded' } }, 529),
      'POST /rest/v1/rpc/fail_staff_message': jsonResponse([
        { id: 'msg-9', processing_status: 'failed', processing_error: 'anthropic_request_failed' },
      ]),
    });

    const result = await processStaffMessage(baseInput({ text: 'Any question' }), deps(fetchImpl));

    expect(result.ok).toBe(false);
    expect(result.response).toBeNull();
    expect(result.classification).toBeNull();

    const completeCalls = fetchImpl.calls.filter((c) => c.url.includes('complete_staff_message'));
    const failCalls = fetchImpl.calls.filter((c) => c.url.includes('fail_staff_message'));
    expect(completeCalls).toHaveLength(0);
    expect(failCalls).toHaveLength(1);
  });
});

// ── Staff permission escalation (Carson Reliability Engineering) ───────────
//
// Confirmed live production failure (2026-07-26): Christopher asked "Should
// I buy the alternative instead?" about an out-of-stock ingredient. Carson
// answered "Go ahead and use extra virgin olive oil... that's a standard
// kitchen swap" — authorizing a substitution on the owner's behalf with no
// pre-approval anywhere in stored context. classification was
// 'substitution_request' but owner_attention_required was false,
// next_action_owner was 'staff', and no escalation ever reached Sana.
//
// The forbidden-wording regex below is the literal wording Carson used in
// the live failure. Two corrections vs. the version merged in PR #87:
// "approved" is now guarded by a negative lookbehind (not preceded by a
// letter or hyphen) so it never false-matches a legitimate, truthful
// compound like "pre-approved", "preapproved", "unapproved", or
// "disapproved" (CodeRabbit-confirmed weakness on PR #87); and "standard
// swap" now tolerates one intervening word so it actually catches the
// exact live-failure phrase "standard kitchen swap", which the original
// fixed two-word phrase silently missed.
const FORBIDDEN_SELF_AUTHORIZATION_WORDING = /go ahead|(?<![a-z-])approved\b|that's fine|standard (?:\w+ )?swap|standard practice|\bproceed\b/i;

describe('FORBIDDEN_SELF_AUTHORIZATION_WORDING regex', () => {
  it('does not false-match legitimate truthful compounds', () => {
    expect("I don't have this pre-approved, so I'm checking with the owner.").not.toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
    expect('This substitution is currently unapproved.').not.toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
    expect('The owner has disapproved similar swaps before.').not.toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
  });

  it('still catches the real self-authorization wording from the live failure', () => {
    expect('Go ahead and use extra virgin olive oil.').toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
    expect("That's approved.").toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
    expect("That's a standard swap.").toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
    // The exact live-failure sentence — verbatim from production.
    expect("Go ahead and use extra virgin olive oil as the substitute — that's a standard kitchen swap.").toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
    expect('Please proceed with the substitution.').toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
  });
});

describe('SYSTEM_PROMPT — staff permission escalation hard rule', () => {
  it('locks in the mandatory-escalation clause for staff permission requests (deliberate-failure guard)', () => {
    const prompt = SYSTEM_PROMPT.toLowerCase();

    // The specific permission-seeking phrasings the product rule requires
    // Carson to recognize.
    expect(prompt).toContain('should i');
    expect(prompt).toContain('can i');
    expect(prompt).toContain('is it okay if');
    expect(prompt).toContain('do you approve');
    expect(prompt).toContain('may i');

    // The mandatory outcome when no pre-approval exists.
    expect(prompt).toMatch(/hard rule.*permission/);
    expect(prompt).toContain('owner_attention_required true');
    expect(prompt).toContain('next_action_owner "owner"');
    expect(prompt).toContain('user_facing_state "needs you"');

    // The pre-approval exception must be scoped to real supplied context,
    // and Carson must never invent authorization wording.
    expect(prompt).toContain('explicitly pre-approved');
    expect(prompt).toContain('never authorized to approve');
    expect(prompt).toMatch(/never write "go ahead"/);
  });
});

describe('processStaffMessage — staff permission escalation (Carson Reliability Engineering)', () => {
  it('A. explicit permission request, no pre-approval, must escalate with no self-authorization wording', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-perm-a', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Christopher', role: 'Cook' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'substitution_request',
        reply_to_staff: "I'm checking that with the owner, I'll come back to you.",
        escalate: true,
        escalation_reason: 'Christopher wants to buy extra virgin olive oil since regular olive oil is unavailable. Decision needed: approve the substitute purchase.',
        recommended_option: 'Approve extra virgin olive oil as the substitute.',
        next_action_owner: 'owner',
        user_facing_state: 'Needs You',
        owner_attention_required: true,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-perm-a', classification: 'substitution_request',
          carson_response: "I'm checking that with the owner, I'll come back to you.",
          next_action_owner: 'owner', user_facing_state: 'Needs You', owner_attention_required: true,
          escalation_reason: 'Christopher wants to buy extra virgin olive oil since regular olive oil is unavailable. Decision needed: approve the substitute purchase.',
          task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'The regular olive oil is unavailable. Can I buy extra virgin olive oil instead?' }),
      deps(fetchImpl),
    );

    expect(result.classification).toBe('substitution_request');
    expect(result.ownerAttentionRequired).toBe(true);
    expect(result.nextActionOwner).toBe('owner');
    expect(result.userFacingState).toBe('Needs You');
    expect(result.escalationReason).toBeTruthy();
    expect(result.response).not.toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
  });

  it('B. "Is it okay if I replace..." must escalate', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-perm-b', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Christopher', role: 'Cook' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'substitution_request',
        reply_to_staff: "I'm checking that with the owner, I'll come back to you.",
        escalate: true,
        escalation_reason: 'Christopher is asking to replace the requested brand. Decision needed: approve the brand substitution.',
        recommended_option: null,
        next_action_owner: 'owner',
        user_facing_state: 'Needs You',
        owner_attention_required: true,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-perm-b', classification: 'substitution_request',
          carson_response: "I'm checking that with the owner, I'll come back to you.",
          next_action_owner: 'owner', user_facing_state: 'Needs You', owner_attention_required: true,
          escalation_reason: 'Christopher is asking to replace the requested brand. Decision needed: approve the brand substitution.',
          task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'Is it okay if I replace the requested brand?' }),
      deps(fetchImpl),
    );

    expect(result.ownerAttentionRequired).toBe(true);
    expect(result.nextActionOwner).toBe('owner');
    expect(result.userFacingState).toBe('Needs You');
  });

  it('C. "Should I buy the alternative instead?" (the exact live-failure phrasing) must escalate', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-perm-c', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Christopher', role: 'Cook' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'substitution_request',
        reply_to_staff: "I'm checking that with the owner, I'll come back to you.",
        escalate: true,
        escalation_reason: 'Christopher wants to buy the alternative he mentioned instead of the requested item. Decision needed: approve the purchase.',
        recommended_option: null,
        next_action_owner: 'owner',
        user_facing_state: 'Needs You',
        owner_attention_required: true,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-perm-c', classification: 'substitution_request',
          carson_response: "I'm checking that with the owner, I'll come back to you.",
          next_action_owner: 'owner', user_facing_state: 'Needs You', owner_attention_required: true,
          escalation_reason: 'Christopher wants to buy the alternative he mentioned instead of the requested item. Decision needed: approve the purchase.',
          task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'Should I buy the alternative instead?' }),
      deps(fetchImpl),
    );

    expect(result.ownerAttentionRequired).toBe(true);
    expect(result.nextActionOwner).toBe('owner');
    expect(result.userFacingState).toBe('Needs You');
    expect(result.response).not.toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
  });

  it('D. explicit exact pre-approval in HOUSEHOLD RULES must not over-escalate', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-perm-d', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Christopher', role: 'Cook' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([
        { rules: 'If regular olive oil is unavailable, use extra virgin olive oil.' },
      ]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'substitution_request',
        reply_to_staff: 'Yes — extra virgin olive oil is already approved for this. No need to check with the owner.',
        escalate: false,
        escalation_reason: null,
        recommended_option: null,
        next_action_owner: 'nobody',
        user_facing_state: 'Completed',
        owner_attention_required: false,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-perm-d', classification: 'substitution_request',
          carson_response: 'Yes — extra virgin olive oil is already approved for this. No need to check with the owner.',
          next_action_owner: 'nobody', user_facing_state: 'Completed', owner_attention_required: false,
          escalation_reason: null, task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'The regular olive oil is unavailable. Can I buy extra virgin olive oil instead?' }),
      deps(fetchImpl),
    );

    expect(result.ownerAttentionRequired).toBe(false);
    expect(result.nextActionOwner).not.toBe('owner');
    expect(result.userFacingState).not.toBe('Needs You');
  });

  it('E. no invented approval: an escalating reply must never contain self-authorization wording', async () => {
    const fetchImpl = mockFetch({
      'POST /rest/v1/rpc/claim_staff_message': jsonResponse([
        { message_id: 'msg-perm-e', is_new: true, processing_status: 'claimed' },
      ]),
      'GET /rest/v1/people': jsonResponse([{ id: PERSON_ID, name: 'Christopher', role: 'Cook' }]),
      'GET /rest/v1/tasks': jsonResponse([]),
      'GET /rest/v1/household_rules': jsonResponse([]),
      'GET /rest/v1/carson_memory': jsonResponse([]),
      'POST /v1/messages': anthropicJsonResponse({
        classification: 'blocker',
        reply_to_staff: "I don't have approval on file for that swap, so I'm checking with the owner. I'll come back to you.",
        escalate: true,
        escalation_reason: 'Christopher wants to skip a requested step with no stored approval. Decision needed: approve or deny skipping it.',
        recommended_option: null,
        next_action_owner: 'owner',
        user_facing_state: 'Needs You',
        owner_attention_required: true,
      }),
      'POST /rest/v1/rpc/complete_staff_message': jsonResponse([
        {
          id: 'msg-perm-e', classification: 'blocker',
          carson_response: "I don't have approval on file for that swap, so I'm checking with the owner. I'll come back to you.",
          next_action_owner: 'owner', user_facing_state: 'Needs You', owner_attention_required: true,
          escalation_reason: 'Christopher wants to skip a requested step with no stored approval. Decision needed: approve or deny skipping it.',
          task_id: null,
        },
      ]),
    });

    const result = await processStaffMessage(
      baseInput({ text: 'Can I skip this part?' }),
      deps(fetchImpl),
    );

    expect(result.ownerAttentionRequired).toBe(true);
    expect(result.response).not.toMatch(FORBIDDEN_SELF_AUTHORIZATION_WORDING);
  });
});

describe('parseClassificationResponse', () => {
  it('falls back to a safe escalation instead of throwing on malformed JSON', () => {
    const result = parseClassificationResponse('not json at all');
    expect(result.classification).toBe('unclear');
    expect(result.nextActionOwner).toBe('owner');
    expect(result.userFacingState).toBe('Needs You');
    expect(result.escalationReason).toBeTruthy();
  });

  it('coerces an invalid enum value rather than trusting the model output verbatim', () => {
    const result = parseClassificationResponse(JSON.stringify({
      classification: 'not_a_real_category',
      reply_to_staff: 'ok',
      next_action_owner: 'nobody',
      user_facing_state: 'Completed',
    }));
    expect(result.classification).toBe('unclear');
  });
});

describe('buildContextBlock', () => {
  it('labels an unknown staff identity rather than silently omitting it', () => {
    const block = buildContextBlock({ person: null, task: null, householdRules: null, recentMemory: [] });
    expect(block).toContain('STAFF MEMBER: unknown');
  });
});
