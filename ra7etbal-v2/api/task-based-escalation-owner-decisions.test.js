/**
 * Regression tests for the task-based owner decision loop:
 *   - notifyOwnerOfTaskReview (api/_escalation-notify.js)
 *   - buildTaskReviewMessage (same file, via integration)
 *   - fetchTaskDecisionContext routing (api/_owner-whatsapp-routing.js)
 *   - Migration SQL assertions (supabase/migrations/20260801_…sql)
 *
 * All external I/O is replaced with stubs; no network calls are made.
 * Pattern follows staff-escalation-phase-b-golden-contract.test.js:
 *   vi.stubGlobal('fetch', fetchMock) covers both rpc() (uses deps.fetchImpl)
 *   and findOwnerPhone (uses global fetch).
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── shared mocks ─────────────────────────────────────────────────────────────

const whatsappDeliveryMocks = vi.hoisted(() => ({
  beginWhatsappDelivery: vi.fn(async () => 'delivery-1'),
  markWhatsappDeliveryAccepted: vi.fn(async () => {}),
  markWhatsappDeliveryFailed: vi.fn(async () => {}),
  getMetaFailure: vi.fn((result) => ({
    httpStatus: result?.status ?? null,
    code: null,
    subcode: null,
    reason: result?.metaError?.message ?? 'WhatsApp delivery failed.',
  })),
}));

vi.mock('./_whatsapp-delivery.js', () => whatsappDeliveryMocks);

const sendMetaMessageMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, messageId: 'wamid.xxx', metaError: null })));

vi.mock('./send-whatsapp-task.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMetaMessage: sendMetaMessageMock };
});

const { notifyOwnerOfTaskReview } = await import('./_escalation-notify.js');

// ── constants ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY  = 'service-key';
const TASK_ID      = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER_ID      = 'bbbbbbbb-0000-0000-0000-000000000001';
const DECISION_ID  = 'cccccccc-0000-0000-0000-000000000001';
const TOKEN        = 'tok_abc123';

function jsonResponse(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) };
}

function makeDecision(overrides = {}) {
  return {
    id: DECISION_ID,
    user_id: USER_ID,
    task_id: TASK_ID,
    staff_message_id: null,
    review_type: 'uncertain_proof',
    status: 'open',
    owner_notified_at: null,
    deep_link_token: TOKEN,
    ...overrides,
  };
}

const DEPS = { supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY };
const NOTIFICATION_CLAIM = {
  decision_id: DECISION_ID,
  claimed: true,
  claim_token: 'notification-claim-1',
  notification_status: 'sending',
};

beforeEach(() => {
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'test-access-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-number-id-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sendMetaMessageMock.mockClear();
  whatsappDeliveryMocks.beginWhatsappDelivery.mockClear();
});

// ── notifyOwnerOfTaskReview ───────────────────────────────────────────────────

describe('notifyOwnerOfTaskReview', () => {
  it('[happy-path] returns sent when RPC, phone, and Meta all succeed', async () => {
    const decision = makeDecision();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision))              // claim_task_escalation_owner_decision
      .mockResolvedValueOnce(jsonResponse(NOTIFICATION_CLAIM))    // claim notification lease
      .mockResolvedValueOnce(jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse(decision));             // complete notification lease

    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'uncertain_proof', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result.attempted).toBe(true);
    expect(result.status).toBe('sent');
    expect(result.escalationId).toBe(DECISION_ID);
    expect(result.deepLinkToken).toBe(TOKEN);
    // Meta send must have been called exactly once
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
    expect(whatsappDeliveryMocks.beginWhatsappDelivery).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK_ID,
      recipientPhone: '971501234567',
      recipientName: 'Owner',
      metadata: expect.objectContaining({
        escalation_id: DECISION_ID,
        task_id: TASK_ID,
        review_type: 'uncertain_proof',
        owner_phone_number_id: 'phone-number-id-1',
      }),
    }));
    expect(whatsappDeliveryMocks.markWhatsappDeliveryAccepted).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-1',
      metaMessageId: 'wamid.xxx',
      metadata: expect.objectContaining({ escalation_id: DECISION_ID }),
    }));
  });

  it('[idempotency] returns skipped_already_sent when owner_notified_at is already set', async () => {
    const decision = makeDecision({ owner_notified_at: '2026-08-01T10:00:00Z' });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse({
        decision_id: DECISION_ID, claimed: false, claim_token: null, notification_status: 'sent',
      }));

    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'uncertain_proof', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result.attempted).toBe(false);
    expect(result.status).toBe('skipped_already_sent');
    expect(result.escalationId).toBe(DECISION_ID);
    // Must NOT attempt Meta send
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('[concurrency] a live notification lease loser sends no Meta message or delivery row', async () => {
    const decision = makeDecision();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse({
        decision_id: DECISION_ID, claimed: false, claim_token: null, notification_status: 'sending',
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'substitute_review', taskDescription: 'Buy milk' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result).toMatchObject({ attempted: false, status: 'in_progress', reason: 'lease_held_elsewhere' });
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    expect(whatsappDeliveryMocks.beginWhatsappDelivery).not.toHaveBeenCalled();
  });

  it('[canonical binding] fails the lease and does not send when the delivery row is unavailable', async () => {
    whatsappDeliveryMocks.beginWhatsappDelivery.mockResolvedValueOnce(null);
    const decision = makeDecision();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse(NOTIFICATION_CLAIM))
      .mockResolvedValueOnce(jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }]))
      .mockResolvedValueOnce(jsonResponse(decision));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'substitute_review', taskDescription: 'Buy milk' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result).toMatchObject({ status: 'failed', reason: 'delivery_record_unavailable' });
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/rpc/fail_task_review_owner_notification'))).toBe(true);
  });

  it('[rpc-failure] returns failed when claim RPC throws a network error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockRejectedValueOnce(new Error('network_down'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'uncertain_proof', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result.attempted).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('claim_rpc_failed');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('[no-decision-row] returns failed when claim RPC returns null', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(null)); // claim RPC returns null

    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'uncertain_proof', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('no_decision_row');
  });

  it('[no-phone] returns skipped_no_phone when owner has no phone on file', async () => {
    const decision = makeDecision();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision))       // claim
      .mockResolvedValueOnce(jsonResponse(NOTIFICATION_CLAIM))
      .mockResolvedValueOnce(jsonResponse([]))             // findOwnerPhone: no boss row
      .mockResolvedValueOnce(jsonResponse(decision));       // fail notification lease

    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'uncertain_proof', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result.attempted).toBe(true);
    expect(result.status).toBe('skipped_no_phone');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('[not-configured] returns failed when WHATSAPP env vars are absent', async () => {
    vi.unstubAllEnvs(); // clear the stubbed env vars
    const decision = makeDecision();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse(NOTIFICATION_CLAIM))
      .mockResolvedValueOnce(jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }]))
      .mockResolvedValueOnce(jsonResponse(decision));

    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'uncertain_proof', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('not_configured');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('[meta-reject] returns failed when Meta rejects the message', async () => {
    sendMetaMessageMock.mockResolvedValueOnce({ ok: false, messageId: null, metaError: { message: 'rejected' } });

    const decision = makeDecision();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse(NOTIFICATION_CLAIM))
      .mockResolvedValueOnce(jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }]))
      .mockResolvedValueOnce(jsonResponse(decision));

    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'substitute_review', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    expect(result.attempted).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('meta_rejected');
    expect(whatsappDeliveryMocks.markWhatsappDeliveryFailed).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-1',
      failureStage: 'meta_api',
    }));
  });

  it('[completion-failure-after-Meta-acceptance] reports sent without continuing secondary sends', async () => {
    const decision = makeDecision();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse(NOTIFICATION_CLAIM))
      .mockResolvedValueOnce(jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }]))
      .mockRejectedValueOnce(new Error('completion_network_error'))
      .mockResolvedValueOnce(jsonResponse(decision)); // reconciliation_required marker

    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType: 'uncertain_proof', taskDescription: 'Buy milk', assignedTo: 'Christopher' },
      { ...DEPS, fetchImpl: fetchMock },
    );

    // Non-fatal — the send succeeded before the patch
    expect(result.attempted).toBe(true);
    expect(result.status).toBe('sent');
    expect(result.reason).toBe('sent_but_not_recorded');
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
    const reconcileCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/rpc/reconcile_task_review_owner_notification'));
    expect(reconcileCall).toBeTruthy();
    expect(JSON.parse(reconcileCall[1].body)).toMatchObject({
      p_claim_token: 'notification-claim-1',
      p_meta_message_id: 'wamid.xxx',
    });
  });
});

// ── buildTaskReviewMessage — message content ──────────────────────────────────

describe('buildTaskReviewMessage — message text', () => {
  async function getMessageText(reviewType, taskDescription, assignedTo, reviewNote = null) {
    const decision = makeDecision({ review_type: reviewType });
    let capturedArgs = null;

    sendMetaMessageMock.mockImplementationOnce(async (args) => {
      capturedArgs = args;
      return { ok: true, messageId: 'wamid.xxx', metaError: null };
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: assignedTo }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision))
      .mockResolvedValueOnce(jsonResponse(NOTIFICATION_CLAIM))
      .mockResolvedValueOnce(jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }]))
      .mockResolvedValueOnce(jsonResponse(decision));

    vi.stubGlobal('fetch', fetchMock);

    await notifyOwnerOfTaskReview(
      { taskId: TASK_ID, userId: USER_ID, reviewType, taskDescription, assignedTo, reviewNote },
      { ...DEPS, fetchImpl: fetchMock },
    );

    // The message text is inside the payload sent to sendMetaMessage
    return capturedArgs ? JSON.stringify(capturedArgs.payload) : null;
  }

  it('uncertain_proof: contains task description and yes/no prompt', async () => {
    const text = await getMessageText('uncertain_proof', 'Buy organic milk', 'Christopher');
    expect(text).toContain('Buy organic milk');
    expect(text).toMatch(/[Yy]es/);
    expect(text).toMatch(/[Nn]o/);
  });

  it('substitute_review with note: identifies the assignee, the actual proposal, and that a decision is needed -- without repeating the task description', async () => {
    const text = await getMessageText('substitute_review', 'Buy TEREA sticks', 'Christopher', 'Buy Heets instead');
    // 1. Worker/assignee identity present.
    expect(text).toContain('Christopher');
    // 2 & 5. Substitute/alternative meaning is clear and a decision is required
    // -- phrasing is intentionally not locked to one exact copy, since this
    // wording changed on purpose (Repair #5) to remove a duplicated task
    // description; any wording naming a substitute/alternative and asking
    // for approve/reject satisfies the contract.
    expect(text).toMatch(/substitute|alternative/i);
    expect(text).toMatch(/approve|reject|review/i);
    // 3. The actual proposal/note content is present.
    expect(text).toContain('Buy Heets instead');
    // 4. The task description is not unnecessarily duplicated -- it must
    // not appear twice in the composed message.
    const taskOccurrences = (text.match(/Buy TEREA sticks/g) || []).length;
    expect(taskOccurrences).toBeLessThanOrEqual(1);
  });

  it('substitute_review without note: says proposing an alternative', async () => {
    const text = await getMessageText('substitute_review', 'Buy TEREA sticks', 'Christopher', null);
    expect(text).toMatch(/proposing an alternative/i);
  });

  it('correction_limit: mentions correction limit', async () => {
    const text = await getMessageText('correction_limit', 'Clean the office', 'Maria');
    expect(text).toMatch(/correction limit/i);
  });

  it('truncates task description to 80 chars', async () => {
    const longDesc = 'A'.repeat(200);
    const text = await getMessageText('uncertain_proof', longDesc, 'Christopher');
    expect(text).toContain('A'.repeat(80));
    expect(text).not.toContain('A'.repeat(81));
  });
});

describe('20260806 migration — task-review owner notification lease', () => {
  const SQL = readFileSync(
    join(__dirname, '..', 'supabase', 'migrations', '20260806_task_review_owner_notification_lease.sql'),
    'utf-8',
  );

  it('provides claim, complete, and fail RPCs restricted to task-review rows', () => {
    expect(SQL).toContain('claim_task_review_owner_notification');
    expect(SQL).toContain('complete_task_review_owner_notification');
    expect(SQL).toContain('fail_task_review_owner_notification');
    expect(SQL).toContain('reconcile_task_review_owner_notification');
    expect(SQL).toContain('staff_message_id IS NULL');
  });

  it('preserves legacy owner_notified_at rows as terminal and token-gates writes', () => {
    expect(SQL).toContain("v.owner_notified_at IS NOT NULL OR v.owner_notification_status = 'sent'");
    expect(SQL).toContain('owner_notification_token = p_claim_token');
    expect(SQL).toContain("ERRCODE = '40001'");
  });

  it('never automatically reclaims an expired send with an unknown provider outcome', () => {
    expect(SQL).toContain("owner_notification_status = 'reconciliation_required'");
    expect(SQL).toContain("owner_notification_error = 'expired_send_outcome_unknown'");
    expect(SQL).not.toMatch(/OR \(v\.owner_notification_status = 'sending'.*lease_until <= now\(\)\) THEN/s);
  });
});

// ── Migration SQL assertions ──────────────────────────────────────────────────

describe('20260801 migration — task-based escalation owner decisions', () => {
  const SQL = readFileSync(
    join(__dirname, '..', 'supabase', 'migrations', '20260801_task_based_escalation_owner_decisions.sql'),
    'utf-8',
  );

  it('drops NOT NULL from staff_message_id', () => {
    expect(SQL).toContain('ALTER COLUMN staff_message_id DROP NOT NULL');
  });

  it('adds review_type column with correct CHECK constraint', () => {
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS review_type text NOT NULL DEFAULT 'staff_escalation'");
    expect(SQL).toContain("CHECK (review_type IN ('staff_escalation','uncertain_proof','substitute_review','correction_limit'))");
  });

  it('adds owner_notified_at column', () => {
    expect(SQL).toContain('ADD COLUMN IF NOT EXISTS owner_notified_at timestamptz');
  });

  it('creates partial unique index on task_id WHERE staff_message_id IS NULL', () => {
    expect(SQL).toContain('staff_escalation_owner_decisions_task_only_open_idx');
    expect(SQL).toContain('WHERE staff_message_id IS NULL');
    expect(SQL).toMatch(/status NOT IN \('delivered_to_staff', 'failed'\)/);
  });

  it('creates claim_task_escalation_owner_decision RPC as SECURITY DEFINER', () => {
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.claim_task_escalation_owner_decision');
    expect(SQL).toContain('SECURITY DEFINER');
  });

  it('RPC validates review_type input', () => {
    expect(SQL).toContain("IF p_review_type NOT IN ('uncertain_proof', 'substitute_review', 'correction_limit') THEN");
    expect(SQL).toContain("RAISE EXCEPTION 'invalid_review_type'");
  });

  it('RPC verifies task ownership before proceeding', () => {
    expect(SQL).toContain('PERFORM 1 FROM public.tasks WHERE id = p_task_id AND user_id = p_user_id');
    expect(SQL).toContain("RAISE EXCEPTION 'not_authorized'");
  });

  it('RPC uses FOR UPDATE SKIP LOCKED for idempotent re-select', () => {
    expect(SQL).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('RPC uses ON CONFLICT DO NOTHING for concurrent-insert safety', () => {
    expect(SQL).toContain('ON CONFLICT DO NOTHING');
  });

  it('grants execute only to service_role and revokes from PUBLIC, anon, authenticated', () => {
    expect(SQL).toContain('REVOKE EXECUTE ON FUNCTION public.claim_task_escalation_owner_decision');
    expect(SQL).toContain('FROM PUBLIC, anon, authenticated');
    expect(SQL).toContain('GRANT  EXECUTE ON FUNCTION public.claim_task_escalation_owner_decision');
    expect(SQL).toContain('TO service_role');
  });
});

// ── Source-text wiring assertions ─────────────────────────────────────────────

describe('code wiring assertions', () => {
  it('_owner-whatsapp-routing.js defines fetchTaskDecisionContext', () => {
    const src = readFileSync(join(__dirname, '_owner-whatsapp-routing.js'), 'utf-8');
    expect(src).toContain('async function fetchTaskDecisionContext');
  });

  it('_owner-whatsapp-routing.js routes task-based escalation rows', () => {
    const src = readFileSync(join(__dirname, '_owner-whatsapp-routing.js'), 'utf-8');
    expect(src).toContain('escalation.task_id && escalation.owner_notified_at');
    expect(src).toContain('fetchTaskDecisionContext({');
  });

  it('_owner-whatsapp-routing.js selects review_type and owner_notified_at in decision queries', () => {
    const src = readFileSync(join(__dirname, '_owner-whatsapp-routing.js'), 'utf-8');
    expect(src).toContain('review_type');
    expect(src).toContain('owner_notified_at');
  });

  it('task-confirm.js imports and calls notifyOwnerOfTaskReview for uncertain_proof', () => {
    const src = readFileSync(join(__dirname, 'task-confirm.js'), 'utf-8');
    expect(src).toContain('notifyOwnerOfTaskReview');
    expect(src).toContain("from './_escalation-notify.js'");
    expect(src).toContain("reviewType: 'uncertain_proof'");
    expect(src).toContain("reviewType: 'substitute_review'");
  });
});
