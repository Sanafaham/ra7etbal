/**
 * P3 staff-reply clarification (blocked delegation journey, 2026-10-11).
 *
 * Christopher replies "Salmon is unavailable" without quote-reply while he
 * has several pending tasks. Sana is alerted immediately (existing path),
 * Christopher is asked which task it is about, and only his numbered answer
 * links the ORIGINAL staff message. These tests drive handleInboundStaffMessage
 * against an in-memory Supabase; the real SQL semantics (ownership, locks,
 * deadline, rollback) are proven separately in
 * supabase/migrations/verification/staff_reply_clarifications_*.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./send-whatsapp-task.js', () => ({
  buildSmsBody: vi.fn(),
  sendTwilioSms: vi.fn(),
  sendMetaMessage: vi.fn(async () => { throw new Error('use injected sendMetaMessageImpl'); }),
}));
vi.mock('./task-confirm.js', () => ({
  sendOwnerPush: vi.fn(async () => {}),
  handleTaskConfirmationPost: vi.fn(async () => { throw new Error('text must never confirm a task'); }),
}));
vi.mock('./_staff-comms-engine.js', () => ({ processStaffMessage: vi.fn() }));
vi.mock('./_owner-whatsapp-routing.js', () => ({ handleInboundOwnerMessage: vi.fn() }));
vi.mock('./_whatsapp-inbound-observability.js', () => ({ persistWhatsappInboundEvidence: vi.fn(async () => ({ ok: true })) }));

import { handleInboundStaffMessage } from './whatsapp-webhook.js';

const OWNER = 'owner-1';
const SUPABASE_URL = 'https://x.supabase.co';

function makeDb() {
  const db = {
    people: [
      { id: 'person-c', user_id: OWNER, name: 'Christopher', phone: '+15550000001', is_family: false, whatsapp_opted_in: true, whatsapp_consent_at: '2026-07-01T00:00:00Z', whatsapp_consent_method: 'owner_confirmed' },
    ],
    tasks: [
      { id: 'task-pizza', user_id: OWNER, status: 'pending', assigned_to: 'Christopher', description: 'Make a pizza for dinner', created_at: '2026-10-01T00:00:00Z' },
      { id: 'task-salmon', user_id: OWNER, status: 'pending', assigned_to: 'Christopher', description: 'Get salmon for dinner', created_at: '2026-10-11T08:00:00Z' },
      { id: 'task-grace', user_id: OWNER, status: 'pending', assigned_to: 'Grace', description: 'Buy flowers', created_at: '2026-10-11T09:00:00Z' },
      { id: 'task-old-done', user_id: OWNER, status: 'done', assigned_to: 'Christopher', description: 'Old task', created_at: '2026-09-01T00:00:00Z' },
    ],
    messages: [{ user_id: OWNER, whatsapp_message_id: 'wamid.task-salmon-msg', task_id: 'task-salmon', recipient: 'Christopher' }],
    staff: [],
    clarifications: [],
    decisions: [],
    calls: [],
    clock: Date.parse('2026-10-11T10:00:00Z'),
  };
  return db;
}

function q(url) {
  const u = new URL(url);
  const params = {};
  for (const [k, v] of u.searchParams) params[k] = v;
  return { path: u.pathname.replace('/rest/v1/', ''), params };
}
const eq = (params, key) => (params[key]?.startsWith('eq.') ? params[key].slice(3) : undefined);

function installSupabase(db) {
  const fetchMock = vi.fn(async (url, init = {}) => {
    const { path, params } = q(url);
    const body = init.body ? JSON.parse(init.body) : null;
    db.calls.push(path);
    const json = (data) => ({ ok: true, json: async () => data });
    if (path === 'whatsapp_health_state') return json([{ user_id: OWNER }]);
    if (path === 'people') return json(db.people.filter((p) => p.user_id === eq(params, 'user_id')));
    if (path === 'messages') {
      const ctx = eq(params, 'whatsapp_message_id');
      return json(ctx ? db.messages.filter((m) => m.whatsapp_message_id === ctx) : []);
    }
    if (path === 'tasks') {
      const id = eq(params, 'id');
      const user = eq(params, 'user_id');
      if (id) return json(db.tasks.filter((t) => t.id === id && t.user_id === user));
      return json(db.tasks.filter((t) => t.user_id === user && t.status === eq(params, 'status'))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)));
    }
    if (path === 'staff_messages') {
      if (params.inbound_text) return json([]); // recent photo-evidence context
      const ext = eq(params, 'external_message_id');
      if (ext) return json(db.staff.filter((m) => m.external_message_id === ext));
      const transport = eq(params, 'response_transport_message_id');
      if (transport) return json(db.staff.filter((m) => m.response_transport_message_id === transport && m.person_id === eq(params, 'person_id')));
      const id = eq(params, 'id');
      if (id) return json(db.staff.filter((m) => m.id === id));
      return json([]);
    }
    if (path === 'staff_reply_clarifications') {
      let rows = db.clarifications.filter((c) => c.user_id === eq(params, 'user_id') && c.person_id === eq(params, 'person_id'));
      if (eq(params, 'staff_message_id')) rows = rows.filter((c) => c.staff_message_id === eq(params, 'staff_message_id'));
      if (eq(params, 'status')) rows = rows.filter((c) => c.status === eq(params, 'status'));
      if (params.deadline_at) rows = rows.filter((c) => c.deadline_at > Date.parse(params.deadline_at.slice(3)));
      return json(rows);
    }
    if (path.startsWith('rpc/')) return json(rpcs[path.slice(4)](body));
    throw new Error(`unexpected fetch ${url}`);
  });

  const rpcs = {
    claim_staff_message(a) {
      const existing = db.staff.find((m) => m.external_message_id === a.p_external_message_id);
      if (existing) return [{ message_id: existing.id, is_new: false, processing_status: existing.processing_status }];
      const row = { id: `sm-${db.staff.length + 1}`, user_id: a.p_user_id, person_id: a.p_person_id, task_id: a.p_task_id, external_message_id: a.p_external_message_id, inbound_text: a.p_inbound_text, processing_status: 'claimed', response_delivery_status: 'not_required' };
      db.staff.push(row);
      return [{ message_id: row.id, is_new: true, processing_status: 'claimed' }];
    },
    complete_staff_message(a) {
      const row = db.staff.find((m) => m.id === a.p_id);
      Object.assign(row, { processing_status: 'completed', classification: a.p_classification, carson_response: a.p_carson_response, user_facing_state: a.p_user_facing_state, owner_attention_required: a.p_owner_attention_required, next_action_owner: a.p_next_action_owner, response_delivery_status: 'pending' });
      return [row];
    },
    claim_staff_response_delivery(a) {
      const row = db.staff.find((m) => m.id === a.p_id);
      if (row.response_delivery_status === 'delivered' || row.response_delivery_status === 'sending') return [{ claimed: false }];
      row.response_delivery_status = 'sending';
      return [{ claimed: true, claim_token: `tok-${row.id}` }];
    },
    complete_staff_response_delivery(a) {
      const row = db.staff.find((m) => m.id === a.p_id);
      Object.assign(row, { response_delivery_status: 'delivered', response_transport_message_id: a.p_transport_message_id });
      return [row];
    },
    fail_staff_response_delivery(a) {
      db.staff.find((m) => m.id === a.p_id).response_delivery_status = 'failed';
      return [{}];
    },
    open_staff_reply_clarification(a) {
      if (db.failOpen) throw new Error('open failed');
      const existing = db.clarifications.find((c) => c.staff_message_id === a.p_staff_message_id);
      if (existing) return [{ clarification_id: existing.id, is_new: false, ...existing }];
      const msg = db.staff.find((m) => m.id === a.p_staff_message_id);
      const row = { id: `clar-${db.clarifications.length + 1}`, user_id: a.p_user_id, person_id: msg.person_id, staff_message_id: a.p_staff_message_id, candidate_task_ids: a.p_candidate_task_ids, question_text: a.p_question_text, status: 'open', deadline_at: db.clock + a.p_deadline_seconds * 1000, resolved_task_id: null };
      db.clarifications.push(row);
      return [{ clarification_id: row.id, is_new: true, ...row }];
    },
    fail_staff_message(a) {
      db.staff.find((m) => m.id === a.p_id).processing_status = 'failed';
      return [{}];
    },
    resolve_staff_reply_clarification(a) {
      if (db.failResolve) throw new Error('resolve failed');
      const c = db.clarifications.find((x) => x.id === a.p_clarification_id);
      if (a.p_choice > c.candidate_task_ids.length) return [{ outcome: 'invalid_choice', status: c.status }];
      const taskId = a.p_choice === 0 ? null : c.candidate_task_ids[a.p_choice - 1];
      const status = a.p_choice === 0 ? 'unrelated' : 'linked';
      if (c.status !== 'open') {
        return [{ outcome: c.status === status && c.resolved_task_id === taskId ? 'already_resolved' : 'conflict', status: c.status, resolved_task_id: c.resolved_task_id }];
      }
      if (db.clock > c.deadline_at) return [{ outcome: 'expired', status: c.status }];
      if (taskId) {
        const msg = db.staff.find((m) => m.id === c.staff_message_id);
        if (msg.task_id == null) msg.task_id = taskId;
        for (const d of db.decisions) if (d.staff_message_id === c.staff_message_id && d.task_id == null) d.task_id = taskId;
      }
      Object.assign(c, { status, resolved_task_id: taskId, answer_staff_message_id: a.p_answer_staff_message_id });
      return [{ outcome: status, status, staff_message_id: c.staff_message_id, resolved_task_id: taskId }];
    },
  };
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// processStaffMessage stand-in: stores the message like the real engine
// (claim + complete) and returns the scripted classification.
function engine(db, script) {
  return vi.fn(async (input) => {
    const [claim] = (await (await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_staff_message`, { method: 'POST', body: JSON.stringify({ p_user_id: input.userId, p_person_id: input.personId, p_task_id: input.taskId, p_external_message_id: input.externalMessageId, p_inbound_text: input.text }) })).json());
    const out = script(input);
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/complete_staff_message`, { method: 'POST', body: JSON.stringify({ p_id: claim.message_id, p_classification: out.classification, p_carson_response: out.response, p_user_facing_state: out.userFacingState, p_owner_attention_required: out.userFacingState === 'Needs You', p_next_action_owner: 'owner' }) });
    const row = db.staff.find((m) => m.id === claim.message_id);
    row.escalation_reason = out.escalationReason || null;
    return { ok: true, messageId: claim.message_id, response: out.response, classification: out.classification, userFacingState: out.userFacingState, ownerAttentionRequired: out.userFacingState === 'Needs You', escalationReason: out.escalationReason || null, relatedTaskId: input.taskId || null };
  });
}

const BLOCKER = () => ({ classification: 'blocker', response: 'Thanks for letting me know.', userFacingState: 'Needs You', escalationReason: 'Christopher says salmon is unavailable.' });

function harness(db, { script = BLOCKER, metaFails = 0 } = {}) {
  let sends = 0;
  let failures = metaFails;
  const sendMetaMessageImpl = vi.fn(async () => {
    if (failures > 0) { failures -= 1; return { ok: false, metaError: { message: 'meta down' } }; }
    sends += 1;
    return { ok: true, messageId: `wamid.out-${sends}` };
  });
  const ownerAlertsSent = new Set();
  const notifyOwnerOfEscalationImpl = vi.fn(async (input) => {
    // Mirrors the existing claim: one decision record and one accepted send per staff message.
    if (!db.decisions.some((d) => d.staff_message_id === input.staffMessageId)) {
      db.decisions.push({ staff_message_id: input.staffMessageId, task_id: input.taskId });
    }
    if (ownerAlertsSent.has(input.staffMessageId)) return { attempted: false, status: 'sent', reason: 'already_sent' };
    ownerAlertsSent.add(input.staffMessageId);
    return { attempted: true, status: 'sent' };
  });
  const processStaffMessageImpl = engine(db, script);
  const send = (msg) => handleInboundStaffMessage(
    { supabaseUrl: SUPABASE_URL, serviceKey: 'service-key', msg: { from: '15550000001', phoneNumberId: 'pnid', timestamp: '1760176800', mediaId: null, contextMessageId: null, ...msg } },
    { sendMetaMessageImpl, notifyOwnerOfEscalationImpl, processStaffMessageImpl },
  );
  return { send, sendMetaMessageImpl, notifyOwnerOfEscalationImpl, processStaffMessageImpl, ownerAlertsSent };
}

const lastText = (h) => h.sendMetaMessageImpl.mock.calls.at(-1)[0].payload.text.body;

let db;
function advance(ms) { db.clock += ms; vi.setSystemTime(db.clock); }
beforeEach(() => {
  db = makeDb();
  vi.stubEnv('WHATSAPP_ACCESS_TOKEN', 'token');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(db.clock);
  installSupabase(db);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('blocked delegation: "Salmon is unavailable" without quote-reply', () => {
  it('alerts Sana immediately, keeps the message unlinked, and asks which task — persisted before sending', async () => {
    const h = harness(db);
    const result = await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(h.notifyOwnerOfEscalationImpl).toHaveBeenCalledTimes(1);
    expect(h.notifyOwnerOfEscalationImpl.mock.calls[0][0]).toMatchObject({ staffMessageId: 'sm-1', taskId: null });
    const original = db.staff.find((m) => m.external_message_id === 'wamid.in-salmon');
    expect(original.task_id).toBeNull();
    expect(db.clarifications).toHaveLength(1);
    expect(db.clarifications[0].candidate_task_ids).toEqual(['task-salmon', 'task-pizza']); // newest first, Grace's and done tasks excluded
    const text = lastText(h);
    expect(text).toContain("I'm checking with the owner.");
    expect(text).toContain('Which task is this about?\n1. Get salmon for dinner\n2. Make a pizza for dinner');
    expect(text).toContain("Reply with the number, or 0 if it's about something else.");
    // Persisted before the send.
    expect(db.calls.indexOf('rpc/open_staff_reply_clarification')).toBeLessThan(db.calls.indexOf('rpc/claim_staff_response_delivery'));
    expect(db.tasks.find((t) => t.id === 'task-salmon').status).toBe('pending');
  });

  it('a numbered answer links the ORIGINAL message and its owner decision, with no new alert, classification or completion', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    h.processStaffMessageImpl.mockClear();

    const result = await h.send({ messageId: 'wamid.in-answer', body: '1' });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBe('task-salmon');
    expect(db.decisions).toEqual([{ staff_message_id: 'sm-1', task_id: 'task-salmon' }]);
    expect(h.notifyOwnerOfEscalationImpl).toHaveBeenCalledTimes(1);
    expect(h.processStaffMessageImpl).not.toHaveBeenCalled();
    expect(lastText(h)).toBe('Thanks, noted. This is about: Get salmon for dinner');
    const answer = db.staff.find((m) => m.external_message_id === 'wamid.in-answer');
    expect(answer).toMatchObject({ classification: 'task_update', user_facing_state: 'Completed', owner_attention_required: false });
    expect(db.tasks.find((t) => t.id === 'task-salmon').status).toBe('pending');
  });
});

describe('replay and duplicates', () => {
  it('a replayed original never creates a second clarification, question or owner alert', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    const sendsBefore = h.sendMetaMessageImpl.mock.calls.length;

    const replay = await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    expect(replay).toEqual({ handled: true, reason: 'already_claimed' });
    expect(db.clarifications).toHaveLength(1);
    expect(h.sendMetaMessageImpl.mock.calls.length).toBe(sendsBefore);
    expect(h.ownerAlertsSent.size).toBe(1);
    expect(h.processStaffMessageImpl).toHaveBeenCalledTimes(1);
  });

  it('a failed question send is retried once by replay with the same persisted question; Sana was alerted regardless', async () => {
    const h = harness(db, { metaFails: 1 });
    const first = await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    expect(first).toEqual({ handled: false, reason: 'delivery_failed' });
    expect(h.ownerAlertsSent.size).toBe(1);
    const firstText = h.sendMetaMessageImpl.mock.calls[0][0].payload.text.body;

    db.tasks.push({ id: 'task-new', user_id: OWNER, status: 'pending', assigned_to: 'Christopher', description: 'New task after the question', created_at: '2026-10-11T09:59:00Z' });
    const retry = await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    expect(retry).toEqual({ handled: true, reason: 'delivered' });
    expect(lastText(h)).toBe(firstText);
    expect(db.clarifications).toHaveLength(1);
    expect(h.ownerAlertsSent.size).toBe(1);
  });

  it('a replayed answer neither resolves again nor sends a second acknowledgement', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    await h.send({ messageId: 'wamid.in-answer', body: '1' });
    const sends = h.sendMetaMessageImpl.mock.calls.length;
    const resolves = db.calls.filter((c) => c === 'rpc/resolve_staff_reply_clarification').length;

    const replay = await h.send({ messageId: 'wamid.in-answer', body: '1' });

    expect(replay).toEqual({ handled: true, reason: 'already_claimed' });
    expect(db.calls.filter((c) => c === 'rpc/resolve_staff_reply_clarification').length).toBe(resolves);
    expect(h.sendMetaMessageImpl.mock.calls.length).toBe(sends);
  });

  it('a second, different answer is refused and the first link stands', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    await h.send({ messageId: 'wamid.in-answer-1', body: '1' });
    // The clarification is resolved, so a later bare number has no live
    // clarification and falls through to ordinary processing.
    await h.send({ messageId: 'wamid.in-answer-2', body: '2', contextMessageId: 'wamid.out-1' });

    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBe('task-salmon');
    expect(lastText(h)).toBe('I already noted a different answer for that message, so I kept the first one.');
    expect(h.ownerAlertsSent.size).toBe(1);
  });
});

describe('invalid, late and unrelated answers', () => {
  it('an out-of-range number asks again without linking; a valid number still works', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    await h.send({ messageId: 'wamid.in-bad', body: '7' });
    expect(lastText(h)).toBe("Please reply with a number from 1 to 2, or 0 if it's about something else.");
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBeNull();

    await h.send({ messageId: 'wamid.in-good', body: '2' });
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBe('task-pizza');
  });

  it('after the 30-minute deadline a bare number is not an answer and links nothing', async () => {
    const h = harness(db, { script: () => ({ classification: 'unclear', response: 'Could you tell me more?', userFacingState: 'Waiting' }) });
    h.processStaffMessageImpl.mockImplementationOnce(engine(db, BLOCKER));
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    advance(31 * 60 * 1000);

    await h.send({ messageId: 'wamid.in-late', body: '1' });

    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBeNull();
    expect(db.calls).not.toContain('rpc/resolve_staff_reply_clarification');
    expect(h.processStaffMessageImpl).toHaveBeenCalledTimes(2); // processed as an ordinary message
  });

  it('a late answer quoting the question gets a truthful "expired" reply and no link', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    advance(31 * 60 * 1000);

    await h.send({ messageId: 'wamid.in-late', body: '1', contextMessageId: 'wamid.out-1' });

    expect(lastText(h)).toContain('That question has expired.');
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBeNull();
  });

  it('0 closes the question as "something else" with no link and no new alert', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    await h.send({ messageId: 'wamid.in-zero', body: '0' });

    expect(db.clarifications[0].status).toBe('unrelated');
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBeNull();
    expect(h.ownerAlertsSent.size).toBe(1);
  });

  it('an unrelated message never gets a task question', async () => {
    const h = harness(db, { script: () => ({ classification: 'routine_question', response: 'Good morning!', userFacingState: 'Completed' }) });
    await h.send({ messageId: 'wamid.in-hello', body: 'Good morning' });

    expect(db.clarifications).toHaveLength(0);
    expect(lastText(h)).toBe('Good morning!');
    expect(h.notifyOwnerOfEscalationImpl).not.toHaveBeenCalled();
  });

  it('a bare number with no clarification is ordinary processing', async () => {
    const h = harness(db, { script: () => ({ classification: 'unclear', response: 'What does 2 refer to?', userFacingState: 'Waiting' }) });
    await h.send({ messageId: 'wamid.in-two', body: '2' });
    expect(h.processStaffMessageImpl).toHaveBeenCalledTimes(1);
    expect(db.clarifications).toHaveLength(0);
  });
});

describe('multiple open questions and exact evidence', () => {
  it('two live questions: a bare number is not guessed; quoting the question resolves exactly that one', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-a', body: 'Salmon is unavailable' }); // question delivered as wamid.out-1
    await h.send({ messageId: 'wamid.in-b', body: 'The oven is broken' }); // question delivered as wamid.out-2

    await h.send({ messageId: 'wamid.in-bare', body: '1' });
    expect(lastText(h)).toContain('more than one open question');
    expect(db.calls).not.toContain('rpc/resolve_staff_reply_clarification');

    await h.send({ messageId: 'wamid.in-quoted', body: '2', contextMessageId: 'wamid.out-2' });
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-b').task_id).toBe('task-pizza');
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-a').task_id).toBeNull();
  });

  it('an exact WhatsApp quote-reply to the task message still links directly, with no question', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-quoted-task', body: 'Salmon is unavailable', contextMessageId: 'wamid.task-salmon-msg' });

    expect(h.processStaffMessageImpl.mock.calls[0][0]).toMatchObject({ taskId: 'task-salmon' });
    expect(db.clarifications).toHaveLength(0);
    expect(h.notifyOwnerOfEscalationImpl.mock.calls[0][0]).toMatchObject({ taskId: 'task-salmon' });
  });

  it('a plain-text substitution ask is not linked by recency; it gets the question and still reaches Sana', async () => {
    db.messages.push({ user_id: OWNER, whatsapp_message_id: 'wamid.recent', task_id: 'task-salmon', recipient: 'Christopher', created_at: '2026-10-11T09:00:00Z' });
    const h = harness(db, { script: () => ({ classification: 'substitution_request', response: 'Let me check.', userFacingState: 'Needs You', escalationReason: 'Christopher asks to use sea bass instead of salmon.' }) });

    await h.send({ messageId: 'wamid.in-sub', body: 'No salmon. Can I get sea bass instead?' });

    expect(h.processStaffMessageImpl.mock.calls[0][0]).toMatchObject({ taskId: null });
    expect(db.calls.some((c) => c === 'messages')).toBe(false);
    expect(h.notifyOwnerOfEscalationImpl).toHaveBeenCalledTimes(1);
    expect(db.clarifications).toHaveLength(1);
  });

  it('an unlinked "done" text is never treated as task completion', async () => {
    const h = harness(db, { script: () => ({ classification: 'completion_confirmation', response: 'Thanks!', userFacingState: 'Waiting' }) });
    await h.send({ messageId: 'wamid.in-done', body: 'Done' });

    expect(db.tasks.every((t) => t.status === (t.id === 'task-old-done' ? 'done' : 'pending'))).toBe(true);
    expect(db.clarifications).toHaveLength(1);
    expect(h.notifyOwnerOfEscalationImpl).not.toHaveBeenCalled();
  });

  it('if the question cannot be opened, the staff reply and the owner alert are unaffected', async () => {
    db.failOpen = true;
    const h = harness(db);
    const result = await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    expect(result).toEqual({ handled: true, reason: 'delivered' });
    expect(lastText(h)).toBe("I'm checking with the owner. I'll come back to you.");
    expect(h.ownerAlertsSent.size).toBe(1);
  });

  it('a replay after the reply was already delivered never opens an unseen question', async () => {
    db.failOpen = true;
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    db.failOpen = false;
    // Force a replay through the full path (e.g. a crash after delivery but before Meta got a 200).
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    expect(db.clarifications).toHaveLength(0);
    expect(h.sendMetaMessageImpl).toHaveBeenCalledTimes(1);
  });

  it('if resolving an answer fails, nothing is linked, the answer is marked failed and no success reply is sent', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    const sends = h.sendMetaMessageImpl.mock.calls.length;
    db.failResolve = true;

    const result = await h.send({ messageId: 'wamid.in-answer', body: '1' });

    expect(result).toEqual({ handled: false, reason: 'clarification_answer_failed' });
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-answer').processing_status).toBe('failed');
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBeNull();
    expect(h.sendMetaMessageImpl.mock.calls.length).toBe(sends);
    expect(h.ownerAlertsSent.size).toBe(1);
  });
});

describe('PR #458 review fix: a quoted number is an answer only when it quotes the question', () => {
  it('1. a number quoting the correct question resolves that question', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' }); // question sent as wamid.out-1

    await h.send({ messageId: 'wamid.in-quoted', body: '1', contextMessageId: 'wamid.out-1' });

    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBe('task-salmon');
    expect(lastText(h)).toBe('Thanks, noted. This is about: Get salmon for dinner');
  });

  it('2. a number quoting an unrelated task message never resolves the open question', async () => {
    const h = harness(db, { script: () => ({ classification: 'unclear', response: 'What does 2 refer to?', userFacingState: 'Waiting' }) });
    h.processStaffMessageImpl.mockImplementationOnce(engine(db, BLOCKER));
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    // Exactly one live question exists, but the number quotes the salmon task message instead.
    await h.send({ messageId: 'wamid.in-quote-task', body: '2', contextMessageId: 'wamid.task-salmon-msg' });

    expect(db.calls).not.toContain('rpc/resolve_staff_reply_clarification');
    expect(db.clarifications[0].status).toBe('open');
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBeNull();
    // Ordinary handling with exact quote-reply matching: the new message itself carries the quoted task.
    expect(h.processStaffMessageImpl.mock.calls.at(-1)[0]).toMatchObject({ taskId: 'task-salmon' });
    expect(h.ownerAlertsSent.size).toBe(1);
  });

  it('2b. a number quoting an unknown message never falls back to the bare-number path', async () => {
    const h = harness(db, { script: () => ({ classification: 'unclear', response: 'Which message do you mean?', userFacingState: 'Waiting' }) });
    h.processStaffMessageImpl.mockImplementationOnce(engine(db, BLOCKER));
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    await h.send({ messageId: 'wamid.in-quote-unknown', body: '1', contextMessageId: 'wamid.something-else' });

    expect(db.calls).not.toContain('rpc/resolve_staff_reply_clarification');
    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBeNull();
  });

  it('3. a bare number with exactly one live question still works', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });

    await h.send({ messageId: 'wamid.in-bare', body: '2' });

    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBe('task-pizza');
  });

  it('4. conflicting or repeated answers cannot change a resolved link', async () => {
    const h = harness(db);
    await h.send({ messageId: 'wamid.in-salmon', body: 'Salmon is unavailable' });
    await h.send({ messageId: 'wamid.in-first', body: '1', contextMessageId: 'wamid.out-1' });

    await h.send({ messageId: 'wamid.in-repeat', body: '1', contextMessageId: 'wamid.out-1' });
    expect(lastText(h)).toBe('Thanks, noted. This is about: Get salmon for dinner');
    await h.send({ messageId: 'wamid.in-conflict', body: '2', contextMessageId: 'wamid.out-1' });
    expect(lastText(h)).toBe('I already noted a different answer for that message, so I kept the first one.');
    // A number quoting the task message is ordinary handling (classified like any other message), never an answer.
    h.processStaffMessageImpl.mockImplementationOnce(engine(db, () => ({ classification: 'unclear', response: 'What does 2 refer to?', userFacingState: 'Waiting' })));
    await h.send({ messageId: 'wamid.in-quote-task', body: '2', contextMessageId: 'wamid.task-salmon-msg' });

    expect(db.staff.find((m) => m.external_message_id === 'wamid.in-salmon').task_id).toBe('task-salmon');
    expect(db.clarifications[0]).toMatchObject({ status: 'linked', resolved_task_id: 'task-salmon' });
    expect(h.ownerAlertsSent.size).toBe(1);
  });
});
