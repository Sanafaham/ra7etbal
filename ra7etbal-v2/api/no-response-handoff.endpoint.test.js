/**
 * Slice 1 — wiring of the no_response handoff into the two existing entry
 * points: the owner decision endpoint (PATCH /api/task-confirm with
 * deepLinkToken) and the owner notification (notifyOwnerOfTaskReview).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./_account-deletion-guard.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkAccountConsequentialAccess: vi.fn(async () => ({ allowed: true, code: 'allowed' })),
}));

const execMock = vi.hoisted(() => vi.fn());
vi.mock('./_no-response-handoff.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, executeNoResponseChoice: execMock };
});

const deliveryMocks = vi.hoisted(() => ({
  beginWhatsappDelivery: vi.fn(async () => 'delivery-1'),
  markWhatsappDeliveryAccepted: vi.fn(async () => {}),
  markWhatsappDeliveryFailed: vi.fn(async () => {}),
  getMetaFailure: vi.fn(() => ({ reason: 'x' })),
}));
vi.mock('./_whatsapp-delivery.js', () => deliveryMocks);
const sendMetaMessageMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, messageId: 'wamid.owner' })));
vi.mock('./send-whatsapp-task.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendMetaMessage: sendMetaMessageMock };
});
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() } }));

const { default: handler } = await import('./task-confirm.js');
const { notifyOwnerOfTaskReview } = await import('./_escalation-notify.js');

function jsonResponse(body, status = 200) {
  return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
function createRes() {
  const res = { status: vi.fn(() => res), json: vi.fn(() => res), setHeader: vi.fn(), end: vi.fn() };
  return res;
}
const patchReq = (body) => ({ method: 'PATCH', headers: { authorization: 'Bearer good' }, body });

const NR_ROW = {
  id: 'decision-nr', user_id: 'user-1', staff_message_id: null, task_id: 'task-1',
  review_type: 'no_response', status: 'open', owner_reply_text: null, deep_link_token: 'tok-nr',
};

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key');
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-token');
  vi.stubEnv('WHATSAPP_PHONE_NUMBER_ID', 'phone-id');
  execMock.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  sendMetaMessageMock.mockClear();
  Object.values(deliveryMocks).forEach((m) => m.mockClear());
});

describe('PATCH /api/task-confirm — no_response decision', () => {
  function stubLookup(row = NR_ROW) {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' })) // requireOwnerUser
      .mockResolvedValueOnce(jsonResponse([row])); // token lookup
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('routes to the no_response executor with the owner choice and never reads staff_messages', async () => {
    const fetchMock = stubLookup();
    execMock.mockResolvedValue({ kind: 'success', status: 'kept_waiting', choice: 'keep_waiting' });
    const res = createRes();
    await handler(patchReq({ deepLinkToken: 'tok-nr', decision: 'keep_waiting' }), res);
    expect(execMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user-1', choice: 'keep_waiting', replyChannel: 'app',
      decisionRow: expect.objectContaining({ id: 'decision-nr', review_type: 'no_response', task_id: 'task-1' }),
    }));
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, status: 'kept_waiting', choice: 'keep_waiting' });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/staff_messages'))).toBe(false);
    const lookupUrl = String(fetchMock.mock.calls[1][0]);
    expect(lookupUrl).toContain('review_type');
    expect(lookupUrl).toContain('task_id');
  });

  it('a no-longer-current task answers 409 with a truthful message', async () => {
    stubLookup();
    execMock.mockResolvedValue({ kind: 'not_current', reason: 'status_done' });
    const res = createRes();
    await handler(patchReq({ deepLinkToken: 'tok-nr', decision: 'ask_again' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'status_done', error: expect.stringMatching(/nothing was changed or sent/),
    }));
  });

  it.each(['ask_again', 'keep_waiting'])(
    'a SUPERSEDED decision (real executor) answers 409 for %s: no RPC, no send, nothing written',
    async (choice) => {
      const actual = await vi.importActual('./_no-response-handoff.js');
      execMock.mockImplementation(actual.executeNoResponseChoice);
      const fetchMock = stubLookup({ ...NR_ROW, status: 'superseded' });
      const res = createRes();
      await handler(patchReq({ deepLinkToken: 'tok-nr', decision: choice }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reason: 'superseded' }));
      // Only auth + token lookup were fetched: no answer RPC, no claim, no send.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(sendMetaMessageMock).not.toHaveBeenCalled();
      expect(deliveryMocks.beginWhatsappDelivery).not.toHaveBeenCalled();
    },
  );

  it('an invalid choice answers 400', async () => {
    stubLookup();
    execMock.mockResolvedValue({ kind: 'validation_error', message: 'Choose Ask again or Keep waiting.' });
    const res = createRes();
    await handler(patchReq({ deepLinkToken: 'tok-nr', decision: 'approved' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("another household's no_response token is an invalid link, and nothing executes", async () => {
    stubLookup({ ...NR_ROW, user_id: 'someone-else' });
    const res = createRes();
    await handler(patchReq({ deepLinkToken: 'tok-nr', decision: 'ask_again' }), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('staff-message-backed decisions never reach the no_response executor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ id: 'user-1' }))
      .mockResolvedValueOnce(jsonResponse([{ ...NR_ROW, staff_message_id: 'sm-1', review_type: 'staff_escalation' }]))
      .mockResolvedValue(jsonResponse([]));
    vi.stubGlobal('fetch', fetchMock);
    const res = createRes();
    await handler(patchReq({ deepLinkToken: 'tok-nr', decision: 'approved' }), res);
    expect(execMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/staff_messages'))).toBe(true);
  });
});

/**
 * URL-routed fetch fake for notifyOwnerOfTaskReview. `claims` is the queue of
 * rows claim_task_escalation_owner_decision returns, in call order.
 */
function notifyFetch({ claims, decisionStatus = 'open', statusReadOk = true }) {
  const queue = [...claims];
  return vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('select=name,role,phone')) return jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }]);
    if (u.includes('/rest/v1/people')) return jsonResponse([{ id: 'person-1', name: 'Christopher' }]);
    if (u.includes('claim_task_escalation_owner_decision')) return jsonResponse(queue.shift() ?? null);
    if (u.includes('claim_task_review_owner_notification')) {
      return jsonResponse({ claimed: true, claim_token: 'n-1', notification_status: 'sending' });
    }
    if (u.includes('fail_task_review_owner_notification')) return jsonResponse({});
    if (u.includes('/rest/v1/staff_escalation_owner_decisions')) {
      return statusReadOk ? jsonResponse([{ status: decisionStatus }]) : jsonResponse({ message: 'boom' }, 500);
    }
    return jsonResponse({});
  });
}
const DEPS = (fetchMock) => ({ supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock });
const claimCalls = (fetchMock) =>
  fetchMock.mock.calls.filter(([u]) => String(u).includes('claim_task_escalation_owner_decision'));

describe('notifyOwnerOfTaskReview — one task-only slot per task', () => {
  it.each([
    ['uncertain_proof', 'no_response'],
    ['substitute_review', 'no_response'],
  ])('a %s request that still gets a %s row after its one retry fails loudly and sends nothing', async (requested, held) => {
    const held_row = { ...NR_ROW, review_type: held, status: 'answered', owner_notified_at: 'x' };
    const fetchMock = notifyFetch({ claims: [held_row, held_row] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await notifyOwnerOfTaskReview(
      { taskId: 'task-1', userId: 'user-1', reviewType: requested, taskDescription: 'x', assignedTo: 'Christopher' },
      DEPS(fetchMock),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'task_slot_held_by_other_review' });
    expect(claimCalls(fetchMock)).toHaveLength(2);
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('claim_task_review_owner_notification'))).toBe(false);
  });

  it('a no_response request never retries and never reuses an active substitute_review row', async () => {
    const fetchMock = notifyFetch({ claims: [{ ...NR_ROW, review_type: 'substitute_review', status: 'answered' }] });
    vi.stubGlobal('fetch', fetchMock);
    const result = await notifyOwnerOfTaskReview(
      { taskId: 'task-1', userId: 'user-1', reviewType: 'no_response', taskDescription: 'x', assignedTo: 'Christopher' },
      DEPS(fetchMock),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'task_slot_held_by_other_review' });
    expect(claimCalls(fetchMock)).toHaveLength(1);
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it.each(['uncertain_proof', 'substitute_review'])(
    'insert-first race: a %s claim that got the sweep\'s just-committed no_response row retries once, for the SAME task, and the proof becomes current',
    async (requested) => {
      const proofRow = { ...NR_ROW, id: 'decision-proof', review_type: requested, status: 'open', deep_link_token: 'tok-proof' };
      const fetchMock = notifyFetch({ claims: [{ ...NR_ROW, status: 'open' }, proofRow] });
      vi.stubGlobal('fetch', fetchMock);
      const result = await notifyOwnerOfTaskReview(
        { taskId: 'task-1', userId: 'user-1', reviewType: requested, taskDescription: 'x', assignedTo: 'Christopher' },
        DEPS(fetchMock),
      );
      const calls = claimCalls(fetchMock).map(([, init]) => JSON.parse(init.body));
      expect(calls).toHaveLength(2);
      // Identity boundary: both claims are for the same task UUID and owner.
      for (const body of calls) expect(body).toMatchObject({ p_task_id: 'task-1', p_user_id: 'user-1', p_review_type: requested });
      expect(result.escalationId).toBe('decision-proof');
      const leaseCall = fetchMock.mock.calls.find(([u]) => String(u).includes('claim_task_review_owner_notification'));
      expect(JSON.parse(leaseCall[1].body)).toMatchObject({ p_id: 'decision-proof' });
    },
  );
});

describe('notifyOwnerOfTaskReview — no_response notification re-checks the decision before sending', () => {
  it.each([
    ['superseded', 'decision_superseded'],
    ['answered', 'decision_answered'],
  ])('decision became %s after the lease: nothing is sent, the lease is released as %s', async (status, reason) => {
    const fetchMock = notifyFetch({ claims: [{ ...NR_ROW, owner_notified_at: null }], decisionStatus: status });
    vi.stubGlobal('fetch', fetchMock);
    const result = await notifyOwnerOfTaskReview(
      { taskId: 'task-1', userId: 'user-1', reviewType: 'no_response', taskDescription: 'x', assignedTo: 'Christopher' },
      DEPS(fetchMock),
    );
    expect(result).toMatchObject({ status: 'failed', reason });
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    expect(deliveryMocks.beginWhatsappDelivery).not.toHaveBeenCalled();
    const failCall = fetchMock.mock.calls.find(([u]) => String(u).includes('fail_task_review_owner_notification'));
    expect(JSON.parse(failCall[1].body)).toMatchObject({ p_id: 'decision-nr', p_claim_token: 'n-1', p_error: reason });
  });

  it('an unreadable decision fails closed: nothing is sent', async () => {
    const fetchMock = notifyFetch({ claims: [{ ...NR_ROW, owner_notified_at: null }], statusReadOk: false });
    vi.stubGlobal('fetch', fetchMock);
    const result = await notifyOwnerOfTaskReview(
      { taskId: 'task-1', userId: 'user-1', reviewType: 'no_response', taskDescription: 'x', assignedTo: 'Christopher' },
      DEPS(fetchMock),
    );
    expect(result).toMatchObject({ status: 'failed', reason: 'pre_send_state_unavailable' });
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('proof review notifications never do the no_response status read', async () => {
    const proofRow = { ...NR_ROW, id: 'decision-proof', review_type: 'uncertain_proof' };
    const fetchMock = notifyFetch({ claims: [proofRow] });
    vi.stubGlobal('fetch', fetchMock);
    await notifyOwnerOfTaskReview(
      { taskId: 'task-1', userId: 'user-1', reviewType: 'uncertain_proof', taskDescription: 'x', assignedTo: 'Christopher' },
      DEPS(fetchMock),
    );
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/rest/v1/staff_escalation_owner_decisions?'))).toBe(false);
    expect(claimCalls(fetchMock)).toHaveLength(1);
  });
});

describe('notifyOwnerOfTaskReview — no_response owner message', () => {
  it('claims a no_response decision and sends the truthful handoff with its decision link', async () => {
    const decision = { ...NR_ROW, owner_notified_at: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([{ id: 'person-1', name: 'Christopher' }])) // resolveAssigneePersonId
      .mockResolvedValueOnce(jsonResponse(decision)) // claim_task_escalation_owner_decision
      .mockResolvedValueOnce(jsonResponse({ decision_id: 'decision-nr', claimed: true, claim_token: 'n-1', notification_status: 'sending' }))
      .mockResolvedValueOnce(jsonResponse([{ name: 'boss', role: 'boss', phone: '+971501234567' }])) // findOwnerPhone
      .mockResolvedValueOnce(jsonResponse([{ status: 'open' }])) // pre-send decision status re-read
      .mockResolvedValueOnce(jsonResponse(decision)); // complete notification lease
    vi.stubGlobal('fetch', fetchMock);

    const result = await notifyOwnerOfTaskReview(
      { taskId: 'task-1', userId: 'user-1', reviewType: 'no_response', taskDescription: 'call me now.', assignedTo: 'Christopher' },
      { supabaseUrl: 'https://example.supabase.co', serviceKey: 'service-key', fetchImpl: fetchMock },
    );

    expect(result.status).toBe('sent');
    const claimCall = fetchMock.mock.calls.find(([u]) => String(u).includes('claim_task_escalation_owner_decision'));
    expect(JSON.parse(claimCall[1].body)).toMatchObject({ p_review_type: 'no_response', p_task_id: 'task-1' });
    expect(sendMetaMessageMock).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(sendMetaMessageMock.mock.calls[0][0].payload);
    expect(payload).toContain("Christopher hasn't replied about");
    expect(payload).toContain('https://www.ra7etbal.com/confirm?task=tok-nr');
    expect(payload).not.toMatch(/approve or reject|Reply Yes/i);
  });
});
