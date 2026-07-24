import { afterEach, describe, expect, it, vi } from 'vitest';
import { processStaffMessage, parseClassificationResponse, buildContextBlock } from './_staff-comms-engine.js';

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
