import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCanonicalStaffDecisionMessage, resolveStaffAnswerText, savedAnswerUndeliverableMessage } from './_staff-decision-message.js';
import { ownerPerspectiveClarification } from '../shared/owner-perspective.js';

/**
 * Protected: an owner's answer to a staff question reaches the staff member
 * only through the single owner-perspective boundary
 * (shared/owner-perspective.js). The "From the owner:" framing does not excuse
 * an unresolved "I"/"me"/"my"; an answer that cannot be resolved is refused
 * BEFORE it is saved, nothing is sent, and the owner is asked to rephrase.
 * The staff-question decision workflow and routing are unchanged.
 *
 * RETIRED PIN (_staff-decision-message.js doc + staff-decision golden
 * contract): "staff can only ever receive … the owner's own words verbatim
 * under the 'From the owner:' prefix". Verbatim owner first person read to
 * staff as the business number speaking ("From the owner: bring me the
 * receipt" — me = Ra7etBal?). Replaced by: the owner's words resolved through
 * the shared boundary (owner named, staff as "you"), or refused. Answers with
 * no owner reference still arrive byte-for-byte unchanged.
 */

const sendMetaMessageMock = vi.hoisted(() => vi.fn());
vi.mock('./send-whatsapp-task.js', async (importOriginal) => ({ ...(await importOriginal()), sendMetaMessage: sendMetaMessageMock }));
// Account-deletion freeze (main, #432/#435) is not under test here: the account is active, same pattern as
// main's staff-decision-golden-contract.test.js. The guard itself is covered by _account-deletion-guard.test.js.
vi.mock('./_account-deletion-guard.js', async (importOriginal) => ({
  ...(await importOriginal()),
  checkAccountConsequentialAccess: vi.fn(async () => ({ allowed: true, code: 'allowed' })),
}));

const { resolveAndDeliverEscalationAnswer, buildStaffAnswerMessageText } = await import('./task-confirm.js');
const handler = (await import('./task-confirm.js')).default;

const SUPABASE_URL = 'https://example.supabase.co';
const SERVICE_KEY = 'service-key';
const TASK_ID = 'dddddddd-4444-4444-8444-444444444444';
const STAFF_MESSAGE = {
  id: 'staff-msg-1', user_id: 'user-1', person_id: 'person-1', staff_name: 'Christopher',
  staff_phone: '+15559990001', inbound_text: 'Can I buy the bigger bouquet?', owner_notification_status: 'sent',
};
const jsonOk = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
const openEscalation = (taskId) => ({
  id: 'esc-1', user_id: 'user-1', staff_message_id: taskId ? null : 'staff-msg-1', task_id: taskId,
  review_type: taskId ? 'substitute_review' : 'staff_escalation', status: 'open', owner_reply_text: null,
  deep_link_token: 'token-1',
});

describe('staff answer text — the canonical builder resolves owner perspective', () => {
  it('an answer with no owner reference is unchanged (existing safe answers still send exactly)', () => {
    expect(buildCanonicalStaffDecisionMessage({ decision: 'custom_instruction', instructionText: 'Buy the Turquoise instead.', staffName: 'Christopher' }))
      .toBe('From the owner: Buy the Turquoise instead.');
  });
  it('owner first person is rendered with the owner named; the staff member stays "you"', () => {
    expect(buildCanonicalStaffDecisionMessage({ decision: 'custom_instruction', instructionText: 'Bring me the receipt.', ownerName: 'Sana', staffName: 'Christopher' }))
      .toBe('From the owner: Bring Sana the receipt.');
    expect(resolveStaffAnswerText("I'll call you after the meeting.", { ownerName: 'Sana', staffName: 'Christopher' }))
      .toBe('Sana will call you after the meeting.');
  });
  it('Approve/Reject on an escalation quotes the staff member\'s own words and never renders their "I" as the owner (checker L2)', () => {
    const replyText = 'Christopher, this was approved: "Is 2" pipe ok, I will get 3" if not" — please go ahead.';
    expect(buildStaffAnswerMessageText({ decision: 'approved', replyText, staffName: 'Christopher', ownerName: 'Sana', isTaskBasedDecision: false }))
      .toBe(replyText);
  });
  it('he/him/her in an answer is whoever the staff member asked about — never turned into the staff member (checker B1)', () => {
    // Pre-fix output: "From the owner: Yes let you in, Sana wants you to clean the kitchen."
    expect(buildStaffAnswerMessageText({ decision: 'custom_instruction', replyText: 'Yes let her in, I want her to clean the kitchen.', ownerName: 'Sana', staffName: 'Christopher', isTaskBasedDecision: true }))
      .toBe('From the owner: Yes let her in, Sana wants her to clean the kitchen.');
    expect(resolveStaffAnswerText('I need him to come early.', { ownerName: 'Sana', staffName: 'Christopher' }))
      .toBe('Sana needs him to come early.');
  });
  it.each([
    ['Bring me the receipt.', null, 'no_owner_name'],
    ['Grace said I would pay.', 'Sana', 'reported_speech_first_person'],
    ['I did it myself.', 'Sana', 'owner_reflexive'],
    ['Tell Christopher to wait for me.', 'Sana', 'recipient_named_as_third_party'],
    ['اشتري الكبير', 'Sana', 'unverifiable_language'],
    ['Büyüğünü al', 'Sana', 'unverifiable_language'],
  ])('cannot bypass the boundary: %j fails closed (%s)', (text, ownerName, reason) => {
    expect(() => buildCanonicalStaffDecisionMessage({ decision: 'custom_instruction', instructionText: text, ownerName, staffName: 'Christopher' }))
      .toThrow(expect.objectContaining({ code: 'owner_perspective_unresolved', reason }));
  });
  it('fixed approve/reject sentences never carry owner text, so they are unaffected', () => {
    expect(buildCanonicalStaffDecisionMessage({ decision: 'approved', instructionText: 'Bring me the receipt.' })).toBe('Approved. You can go ahead.');
  });
  it('plain staff_escalation replies keep the recipient-certain normalization, then pass the same boundary', () => {
    expect(buildStaffAnswerMessageText({
      decision: 'custom_instruction', replyText: 'Yes he can buy the bouquet. Send me the bill.',
      staffName: 'Christopher', ownerName: 'Sana', isTaskBasedDecision: false, confirmationUrl: null,
    })).toBe('Yes, you can buy the bouquet. Send Sana the bill.');
  });
});

describe('staff answer — refused BEFORE it is saved; nothing sent', () => {
  beforeEach(() => {
    sendMetaMessageMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['task-based (substitute review)', TASK_ID],
    ['staff escalation', null],
  ])('%s: an ambiguous answer returns owner_perspective_unresolved, with no answer RPC and no staff send', async (_label, taskId) => {
    // Only the owner-name read is allowed; any other call (answer RPC, lease, send) fails the test.
    const fetchMock = vi.fn(async (url) => {
      if (String(url).includes('/profiles?')) return jsonOk([{ display_name: 'Sana' }]);
      throw new Error(`no other database call may happen: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await resolveAndDeliverEscalationAnswer({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, userId: 'user-1', deepLinkToken: 'token-1',
      escalation: openEscalation(taskId), staffMessage: STAFF_MESSAGE, staffContextText: STAFF_MESSAGE.inbound_text,
      decision: 'custom_instruction', instructionText: 'Ali said I would come later.', replyChannel: 'whatsapp',
      verifiedPhoneNumberId: 'phone-id-1',
    });
    expect(result).toMatchObject({
      kind: 'owner_perspective_unresolved', persisted: false, reason: 'reported_speech_first_person',
      message: ownerPerspectiveClarification('Christopher'),
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url)).every((url) => url.includes('/profiles?'))).toBe(true);
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('unverifiable Arabic/Turkish answers are refused with no database call at all', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('no database call may happen'); });
    vi.stubGlobal('fetch', fetchMock);
    for (const instructionText of ['اشتري الكبير', 'Büyüğünü al']) {
      const result = await resolveAndDeliverEscalationAnswer({
        supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, userId: 'user-1', deepLinkToken: 'token-1',
        escalation: openEscalation(TASK_ID), staffMessage: STAFF_MESSAGE, staffContextText: STAFF_MESSAGE.inbound_text,
        decision: 'custom_instruction', instructionText, replyChannel: 'whatsapp', verifiedPhoneNumberId: 'phone-id-1',
      });
      expect(result, instructionText).toMatchObject({ kind: 'owner_perspective_unresolved', reason: 'unverifiable_language', persisted: false });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });

  it('an owner reference is resolved with the owner name (one profile read) BEFORE the raw answer is saved', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
      if (String(url).includes('/profiles?')) return jsonOk([{ display_name: 'Sana' }]);
      return { ok: false, status: 500, json: async () => ({ message: 'stop here' }), text: async () => 'stop here' };
    }));
    const result = await resolveAndDeliverEscalationAnswer({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, userId: 'user-1', deepLinkToken: 'token-1',
      escalation: openEscalation(TASK_ID), staffMessage: STAFF_MESSAGE, staffContextText: STAFF_MESSAGE.inbound_text,
      decision: 'custom_instruction', instructionText: 'Bring me the receipt.', replyChannel: 'whatsapp',
      verifiedPhoneNumberId: 'phone-id-1',
    });
    expect(calls[0].url).toContain('/profiles?');
    expect(calls[1].url).toContain('/rpc/answer_escalation_owner_decision');
    // The owner's own words are what is saved (audit source); only the staff-facing text is resolved.
    expect(calls[1].body.p_owner_reply_text).toBe('Bring me the receipt.');
    expect(result.kind).toBe('rpc_error');
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
  });
});

describe('an answer saved BEFORE this boundary that cannot be delivered safely — truthful recovery message', () => {
  // Production read-only count at 5db8d3f+: 0 such rows (0 answered, 0
  // delivering, 1 failed row with text that the boundary passes). The state
  // machine is first-write-wins (answer_escalation_owner_decision only saves
  // while 'open'), so the owner cannot replace a saved answer here: the reply
  // must never claim that rephrasing will fix it.
  beforeEach(() => {
    sendMetaMessageMock.mockReset();
    vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'meta-token');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is not sent, releases the lease as failed, and tells the owner to contact the staff member directly', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const u = String(url);
      calls.push({ url: u, body: options.body ? JSON.parse(options.body) : null });
      if (u.includes('/rpc/claim_escalation_answer_delivery')) {
        return jsonOk([{ id: 'esc-1', claimed: true, claim_token: 'lease-1', reply_text: 'Grace said I would pay.', delivery_status: 'delivering' }]);
      }
      if (u.includes('/rest/v1/people?')) return jsonOk([{ id: 'person-1', phone: '+15559990001', whatsapp_opted_in: true }]);
      if (u.includes('/rest/v1/profiles?')) return jsonOk([{ display_name: 'Sana' }]);
      if (u.includes('/rpc/fail_escalation_answer_delivery')) return jsonOk({ status: 'failed' });
      throw new Error(`unexpected call ${u}`);
    }));
    const result = await resolveAndDeliverEscalationAnswer({
      supabaseUrl: SUPABASE_URL, serviceKey: SERVICE_KEY, userId: 'user-1', deepLinkToken: 'token-1',
      escalation: { ...openEscalation(null), status: 'failed', owner_reply_text: 'Grace said I would pay.' },
      staffMessage: STAFF_MESSAGE, staffContextText: STAFF_MESSAGE.inbound_text,
      decision: 'custom_instruction', instructionText: 'Owner tries a new answer', replyChannel: 'whatsapp',
      verifiedPhoneNumberId: 'phone-id-1',
    });
    expect(result).toMatchObject({ kind: 'owner_perspective_unresolved', persisted: true, message: savedAnswerUndeliverableMessage('Christopher') });
    expect(result.message).toMatch(/was not sent/);
    expect(result.message).toMatch(/can't be changed or resent from here/);
    expect(result.message).toMatch(/contact Christopher directly/);
    expect(result.message).not.toMatch(/say it again|rephrase/i);
    expect(sendMetaMessageMock).not.toHaveBeenCalled();
    expect(calls.some((c) => c.url.includes('/rpc/answer_escalation_owner_decision'))).toBe(false);
    expect(calls.find((c) => c.url.includes('/rpc/fail_escalation_answer_delivery')).body)
      .toMatchObject({ p_claim_token: 'lease-1', p_error: 'owner_perspective_unresolved' });
  });
});

describe('substitute review (Alternative Review UI) — custom instruction refused before the decision is claimed', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns 422 with the rephrase request; claim_substitute_decision is never called', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonOk({ id: 'user-1' })) // auth
      .mockResolvedValueOnce(jsonOk([{
        id: TASK_ID, user_id: 'user-1', description: 'buy flowers', assigned_to: 'Christopher', confirmation_url: null,
        quality_review_status: 'substitute_review', quality_review_note: null, quality_reviewed_at: null, worker_reply: null,
      }]));
    vi.stubGlobal('fetch', fetchMock);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
    await handler({
      method: 'PATCH', headers: { authorization: 'Bearer good-token' },
      body: { taskId: TASK_ID, decision: 'custom_instruction', instructionText: 'Grace said I would pay.' },
    }, res);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({ error: ownerPerspectiveClarification('Christopher'), code: 'owner_perspective_unresolved' });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/rpc/claim_substitute_decision'))).toBe(false);
  });
});
