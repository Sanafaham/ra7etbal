/**
 * Chief-of-Staff Lifecycle Slice 1 — stalled tracked delegation → owner
 * handoff ('no_response') → ASK AGAIN / KEEP WAITING.
 *
 * Exercises api/_no-response-handoff.js against a small in-memory stand-in
 * for PostgREST + the existing staff_escalation_owner_decisions RPCs
 * (answer / claim delivery / complete / fail). The fake reproduces only the
 * semantics the production RPCs document: first-write-wins answers, a
 * single-holder delivery lease, and the task-only-open partial unique index
 * (one active task-only decision per task). No network is used.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const deliveryMocks = vi.hoisted(() => ({
  beginWhatsappDelivery: vi.fn(async () => 'delivery-1'),
  markWhatsappDeliveryAccepted: vi.fn(async () => {}),
  markWhatsappDeliveryFailed: vi.fn(async () => {}),
  getMetaFailure: vi.fn(() => ({ reason: 'meta_rejected' })),
}));
vi.mock('./_whatsapp-delivery.js', () => deliveryMocks);

const {
  NO_RESPONSE_HANDOFF_DELAY_MS,
  NO_RESPONSE_CHOICES,
  readNoResponseCutover,
  evaluateNoResponseHandoff,
  getNoResponseCurrentStateBlock,
  runNoResponseHandoffs,
  executeNoResponseChoice,
  buildNoResponseOwnerMessage,
  buildNoResponseReaskMessage,
  buildNoResponseDeepLink,
} = await import('./_no-response-handoff.js');

const URL_BASE = 'https://db.example';
const KEY = 'service-key';
const OWNER = '645ddb96-6e09-4d91-b650-cbc75bac9a5d';
const HOUR = 3_600_000;

// "Deployment time" for these tests. Every historical escalation predates it.
const DEPLOY_AT = new Date('2026-09-28T12:00:00Z');

// ── In-memory PostgREST + RPC stand-in ───────────────────────────────────────

function makeDb() {
  const db = {
    tasks: [],
    people: [],
    staff_messages: [],
    personal_contact_replies: [],
    staff_escalation_owner_decisions: [],
    profiles: [{ id: OWNER, display_name: 'Sana' }],
    writes: [], // every non-GET REST call, for "no task mutation" assertions
    rpcCalls: [],
    nextId: 1,
  };
  return db;
}

function matches(row, key, expr) {
  const v = row[key];
  if (expr.startsWith('eq.')) return String(v) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return v == null;
  if (expr === 'not.is.null') return v != null;
  if (expr.startsWith('gte.')) return v != null && Date.parse(v) >= Date.parse(decodeURIComponent(expr.slice(4)));
  if (expr.startsWith('lte.')) return v != null && Date.parse(v) <= Date.parse(decodeURIComponent(expr.slice(4)));
  if (expr.startsWith('ilike.')) return String(v || '').toLowerCase() === decodeURIComponent(expr.slice(6)).toLowerCase();
  throw new Error(`unsupported filter ${key}=${expr}`);
}

function applyQuery(rows, search) {
  const params = new URLSearchParams(search);
  let out = rows.slice();
  for (const [key, value] of params.entries()) {
    if (['select', 'order', 'limit'].includes(key)) continue;
    if (key === 'or') {
      const inner = value.replace(/^\(|\)$/g, '').split(',');
      out = out.filter((row) => inner.some((clause) => {
        const [col, ...rest] = clause.split('.');
        return matches(row, col, rest.join('.'));
      }));
      continue;
    }
    out = out.filter((row) => matches(row, key, value));
  }
  const limit = Number(params.get('limit') || 1000);
  return out.slice(0, limit);
}

const ACTIVE = (d) => !['delivered_to_staff', 'failed'].includes(d.status);

function rpc(db, name, args) {
  db.rpcCalls.push({ name, args });
  const decisions = db.staff_escalation_owner_decisions;
  if (name === 'claim_task_escalation_owner_decision') {
    const existing = decisions.find((d) => d.task_id === args.p_task_id && !d.staff_message_id && ACTIVE(d));
    if (existing) return existing;
    const row = {
      id: `decision-${db.nextId++}`, user_id: args.p_user_id, task_id: args.p_task_id,
      staff_message_id: null, review_type: args.p_review_type, status: 'open',
      owner_reply_text: null, answered_at: null, deep_link_token: `token-${db.nextId++}`,
      owner_notification_status: null, owner_notified_at: null, lease: null,
    };
    decisions.push(row);
    return row;
  }
  if (name === 'answer_escalation_owner_decision') {
    const row = decisions.find((d) => d.deep_link_token === args.p_deep_link_token);
    if (!row) return { __error: 'not_found' };
    if (row.status === 'open') {
      row.status = 'answered';
      row.owner_reply_text = args.p_owner_reply_text;
      row.owner_reply_channel = args.p_owner_reply_channel;
      row.answered_at = new Date().toISOString();
      return { ...row };
    }
    if (['answered', 'delivering', 'delivered_to_staff'].includes(row.status)) return { ...row };
    return { __error: 'invalid_transition' };
  }
  if (name === 'claim_escalation_answer_delivery') {
    const row = decisions.find((d) => d.id === args.p_id);
    if (['answered', 'failed'].includes(row.status)) {
      row.status = 'delivering';
      row.lease = `lease-${db.nextId++}`;
      return [{ row_id: row.id, claimed: true, claim_token: row.lease, reply_text: row.owner_reply_text, delivery_status: 'delivering' }];
    }
    return [{ row_id: row.id, claimed: false, claim_token: null, reply_text: row.owner_reply_text, delivery_status: row.status }];
  }
  if (name === 'complete_escalation_answer_delivery') {
    const row = decisions.find((d) => d.id === args.p_id);
    if (row.lease !== args.p_claim_token) return { __error: 'lease_lost' };
    row.status = 'delivered_to_staff';
    row.delivery_transport_message_id = args.p_transport_message_id;
    return { ...row };
  }
  if (name === 'fail_escalation_answer_delivery') {
    const row = decisions.find((d) => d.id === args.p_id);
    if (row.lease === args.p_claim_token) row.status = 'failed';
    return { ...row };
  }
  throw new Error(`unexpected rpc ${name}`);
}

function makeFetch(db) {
  return vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/rest/v1/', '');
    const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
    if (path.startsWith('rpc/')) {
      const out = rpc(db, path.slice(4), JSON.parse(init.body || '{}'));
      if (out?.__error) return json({ message: out.__error }, 409);
      return json(out);
    }
    if ((init.method || 'GET') !== 'GET') {
      db.writes.push({ path, method: init.method, body: init.body });
      return json([]);
    }
    const table = db[path];
    if (!Array.isArray(table)) throw new Error(`unknown table ${path}`);
    return json(applyQuery(table, u.search));
  });
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function person(over = {}) {
  return { id: 'person-chris', user_id: OWNER, name: 'Christopher', phone: '+971500000001', whatsapp_opted_in: true, ...over };
}

function stalledTask(over = {}) {
  const escalated = over.escalated_at ?? new Date(DEPLOY_AT.getTime() + 1 * HOUR).toISOString();
  return {
    id: 'task-fresh',
    user_id: OWNER,
    type: 'delegation',
    description: 'call me now.',
    assigned_to: 'Christopher',
    assigned_person_id: 'person-chris',
    status: 'pending',
    needs_follow_up: true,
    created_at: new Date(Date.parse(escalated) - 20 * 60_000).toISOString(),
    followup_sent_at: new Date(Date.parse(escalated) - 10 * 60_000).toISOString(),
    escalated_at: escalated,
    confirmed_at: null,
    dismissed_at: null,
    archived_at: null,
    quality_review_status: null,
    proof_image_path: null,
    worker_reply: null,
    ...over,
  };
}

/**
 * The 8 real historical stalled escalated delegations in Production as of
 * 2026-09-27 (task text / assignee / escalation date from the read-only audit).
 * All predate any cutover this slice can be activated with.
 */
const HISTORICAL_EIGHT = [
  ['Prepare lunch', 'Grace', '2026-06-11T10:00:00Z'],
  ['do this for snack now', 'Christopher', '2026-07-13T10:00:00Z'],
  ['call me now', 'Nasira', '2026-07-13T10:05:00Z'],
  ['bring the car out', 'Ghulam', '2026-07-13T10:10:00Z'],
  ['bring the car around', 'Christopher', '2026-09-15T10:00:00Z'],
  ['bring the car around', 'Christopher', '2026-09-15T11:00:00Z'],
  ['Make a pizza for dinner', 'Christopher', '2026-09-17T10:00:00Z'],
  ['call me now.', 'Christopher', '2026-09-27T14:33:00Z'],
].map(([description, assigned_to, escalated_at], i) =>
  stalledTask({ id: `historical-${i}`, description, assigned_to, escalated_at, assigned_person_id: 'person-chris' }));

const NOW_AFTER_4H = new Date(DEPLOY_AT.getTime() + 1 * HOUR + NO_RESPONSE_HANDOFF_DELAY_MS + 60_000);

let db;
let fetchImpl;
const ENV_ON = { NO_RESPONSE_HANDOFF_CUTOVER_AT: DEPLOY_AT.toISOString() };

beforeEach(() => {
  db = makeDb();
  db.people.push(person());
  fetchImpl = makeFetch(db);
  Object.values(deliveryMocks).forEach((m) => m.mockClear?.());
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** notify stand-in with the real claim RPC + a single-holder notification lease. */
function makeNotify() {
  const sent = [];
  const notify = vi.fn(async (input) => {
    const decision = rpc(db, 'claim_task_escalation_owner_decision', {
      p_task_id: input.taskId, p_user_id: input.userId, p_review_type: input.reviewType,
    });
    if (decision.owner_notification_status === 'sending' || decision.owner_notification_status === 'sent') {
      return { status: 'in_progress' };
    }
    decision.owner_notification_status = 'sending';
    await Promise.resolve();
    decision.owner_notification_status = 'sent';
    decision.owner_notified_at = new Date().toISOString();
    sent.push(input.taskId);
    return { status: 'sent', deepLinkToken: decision.deep_link_token };
  });
  return { notify, sent };
}

function freshTaskWithDecision(decisionOver = {}, taskOver = {}) {
  const task = stalledTask(taskOver);
  db.tasks.push(task);
  const row = rpc(db, 'claim_task_escalation_owner_decision', {
    p_task_id: task.id, p_user_id: OWNER, p_review_type: 'no_response',
  });
  Object.assign(row, decisionOver);
  db.rpcCalls = [];
  return { task, row };
}

const exec = (row, choice, extra = {}) => executeNoResponseChoice({
  supabaseUrl: URL_BASE, serviceKey: KEY, userId: OWNER, decisionRow: { ...row }, choice,
  fetchImpl, sendImpl: extra.sendImpl, env: { WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'pn' },
});

// ── 1–4: rollout gate, historical exclusion, 4-hour owner decision ──────────

describe('cutover gate — deployment is inert', () => {
  it('unset, blank or malformed cutover disables the stage entirely (zero reads, zero notifications)', async () => {
    for (const env of [{}, { NO_RESPONSE_HANDOFF_CUTOVER_AT: '' }, { NO_RESPONSE_HANDOFF_CUTOVER_AT: 'tomorrow' },
      { NO_RESPONSE_HANDOFF_CUTOVER_AT: '2026-09-28' }]) {
      db.tasks = [...HISTORICAL_EIGHT, stalledTask()];
      const { notify } = makeNotify();
      const stats = await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env, fetchImpl, notify });
      expect(stats.enabled).toBe(false);
      expect(notify).not.toHaveBeenCalled();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.staff_escalation_owner_decisions).toHaveLength(0);
  });

  it('parses only an explicit ISO-8601 instant', () => {
    expect(readNoResponseCutover({ NO_RESPONSE_HANDOFF_CUTOVER_AT: '2026-09-28T12:00:00Z' })?.toISOString())
      .toBe('2026-09-28T12:00:00.000Z');
    expect(readNoResponseCutover({ NO_RESPONSE_HANDOFF_CUTOVER_AT: '2026-09-28T16:00:00+04:00' })?.toISOString())
      .toBe('2026-09-28T12:00:00.000Z');
    expect(readNoResponseCutover({})).toBeNull();
  });
});

describe('historical stalled delegations never participate', () => {
  it('2. all 8 Production historical rows (incl. "call me now.") are ineligible — pre_cutover', () => {
    const cutover = DEPLOY_AT;
    for (const task of HISTORICAL_EIGHT) {
      const v = evaluateNoResponseHandoff({
        task, cutover, now: new Date('2027-01-01T00:00:00Z'),
        evidence: { person: person(), staffReplyFound: false, contactReplyFound: false, decisions: [] },
      });
      expect(v).toEqual({ eligible: false, reason: 'pre_cutover' });
    }
  });

  it('2b. an enabled sweep over the historical 8 creates zero decisions, zero notifications, zero staff messages', async () => {
    db.tasks = [...HISTORICAL_EIGHT];
    const { notify } = makeNotify();
    const stats = await runNoResponseHandoffs({
      supabaseUrl: URL_BASE, serviceKey: KEY, now: new Date('2027-01-01T00:00:00Z'), env: ENV_ON, fetchImpl, notify,
    });
    expect(stats.enabled).toBe(true);
    expect(stats.checked).toBe(0); // excluded by the query itself (escalated_at >= cutover)
    expect(notify).not.toHaveBeenCalled();
    expect(db.staff_escalation_owner_decisions).toHaveLength(0);
    expect(deliveryMocks.beginWhatsappDelivery).not.toHaveBeenCalled();
  });

  it('1. an escalation one millisecond before the cutover is excluded', () => {
    const task = stalledTask({ escalated_at: new Date(DEPLOY_AT.getTime() - 1).toISOString() });
    expect(evaluateNoResponseHandoff({
      task, cutover: DEPLOY_AT, now: NOW_AFTER_4H,
      evidence: { person: person(), staffReplyFound: false, contactReplyFound: false, decisions: [] },
    }).reason).toBe('pre_cutover');
  });
});

describe('4-hour handoff delay (owner product decision)', () => {
  it('is exactly 4 hours and is not derived from the follow-up/escalation thresholds', () => {
    expect(NO_RESPONSE_HANDOFF_DELAY_MS).toBe(4 * 60 * 60 * 1000);
    const src = readFileSync(join(process.cwd(), 'api/_no-response-handoff.js'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    expect(code).toMatch(/NO_RESPONSE_HANDOFF_DELAY_MS = 4 \* 60 \* 60 \* 1000;/);
    expect(code).not.toMatch(/PROD_FOLLOWUP_MS|PROD_ESCALATE_MS|process-delegation-escalations/);
    expect(src).toMatch(/OWNER PRODUCT DECISION/);
  });

  it('4. a post-cutover escalation younger than 4h is not handed off', () => {
    const task = stalledTask();
    const now = new Date(Date.parse(task.escalated_at) + NO_RESPONSE_HANDOFF_DELAY_MS - 1);
    expect(evaluateNoResponseHandoff({
      task, cutover: DEPLOY_AT, now, evidence: { person: person(), decisions: [] },
    }).reason).toBe('handoff_delay_not_reached');
  });

  it('3. a post-cutover escalation at 4h is eligible', () => {
    const task = stalledTask();
    const now = new Date(Date.parse(task.escalated_at) + NO_RESPONSE_HANDOFF_DELAY_MS);
    expect(evaluateNoResponseHandoff({
      task, cutover: DEPLOY_AT, now, evidence: { person: person(), staffReplyFound: false, contactReplyFound: false, decisions: [] },
    })).toEqual({ eligible: true, reason: null, retryNotification: false });
  });

  it('has no permanent age ceiling — a week-old post-cutover escalation is still eligible', () => {
    const task = stalledTask();
    const now = new Date(Date.parse(task.escalated_at) + 7 * 24 * HOUR);
    expect(evaluateNoResponseHandoff({
      task, cutover: DEPLOY_AT, now, evidence: { person: person(), staffReplyFound: false, contactReplyFound: false, decisions: [] },
    }).eligible).toBe(true);
  });
});

// ── 5–7: idempotent sweep, terminal, replies ────────────────────────────────

describe('sweep stage', () => {
  it('3. one fresh post-cutover stall → exactly one decision and one owner notification', async () => {
    db.tasks = [...HISTORICAL_EIGHT, stalledTask()];
    const { notify, sent } = makeNotify();
    await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(sent).toEqual(['task-fresh']);
    expect(db.staff_escalation_owner_decisions).toHaveLength(1);
    expect(db.staff_escalation_owner_decisions[0].review_type).toBe('no_response');
    expect(notify.mock.calls[0][0]).toMatchObject({ reviewType: 'no_response', taskId: 'task-fresh', assignedTo: 'Christopher' });
  });

  it('5. repeated and concurrent sweeps → still one decision and one notification', async () => {
    db.tasks = [stalledTask()];
    const { notify, sent } = makeNotify();
    const run = () => runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    await Promise.all([run(), run(), run()]);
    await run();
    await run();
    expect(db.staff_escalation_owner_decisions).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('the sweep never messages staff and never writes to tasks', async () => {
    db.tasks = [stalledTask()];
    const { notify } = makeNotify();
    await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(db.writes).toHaveLength(0);
    expect(deliveryMocks.beginWhatsappDelivery).not.toHaveBeenCalled();
  });

  it('6. terminal tasks are never handed off', async () => {
    db.tasks = [
      stalledTask({ id: 't-done', status: 'done' }),
      stalledTask({ id: 't-arch', archived_at: '2026-09-28T13:00:00Z' }),
      stalledTask({ id: 't-dism', dismissed_at: '2026-09-28T13:00:00Z' }),
      stalledTask({ id: 't-conf', confirmed_at: '2026-09-28T13:00:00Z' }),
      stalledTask({ id: 't-proof', proof_image_path: 'u/p.jpg' }),
      stalledTask({ id: 't-qi', quality_review_status: 'uncertain' }),
    ];
    const { notify } = makeNotify();
    await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('7. a staff reply, a personal-contact reply or a worker reply suppresses the handoff', async () => {
    const t = stalledTask();
    db.tasks = [t];
    db.staff_messages.push({ id: 'sm1', user_id: OWNER, person_id: 'person-chris', staff_phone: '+971500000001', received_at: t.escalated_at });
    const { notify } = makeNotify();
    const stats = await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(notify).not.toHaveBeenCalled();
    expect(stats.skipped[0].reason).toBe('staff_replied');

    db.staff_messages = [];
    db.personal_contact_replies.push({ id: 'pc1', user_id: OWNER, person_id: 'person-chris', created_at: t.escalated_at });
    const s2 = await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(s2.skipped[0].reason).toBe('contact_replied');

    db.personal_contact_replies = [];
    db.tasks = [stalledTask({ worker_reply: 'on my way' })];
    const s3 = await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(s3.skipped[0].reason).toBe('worker_replied');
    expect(notify).not.toHaveBeenCalled();
  });

  it('a reply matched only by phone (no person_id on the staff message) still suppresses', async () => {
    const t = stalledTask();
    db.tasks = [t];
    db.staff_messages.push({ id: 'sm2', user_id: OWNER, person_id: null, staff_phone: '+971500000001', received_at: t.escalated_at });
    const { notify } = makeNotify();
    await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(notify).not.toHaveBeenCalled();
  });

  it('an unresolvable assignee fails closed (no "hasn\'t replied" claim)', async () => {
    db.people = [];
    db.tasks = [stalledTask({ assigned_person_id: null, assigned_to: 'Nobody' })];
    const { notify } = makeNotify();
    const stats = await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl, notify });
    expect(notify).not.toHaveBeenCalled();
    expect(stats.skipped[0].reason).toBe('assignee_unresolved');
  });

  it('an evidence read failure fails closed', async () => {
    db.tasks = [stalledTask()];
    const failing = vi.fn(async (url, init) => {
      if (String(url).includes('/staff_messages')) return { ok: false, status: 500, json: async () => ({}) };
      return fetchImpl(url, init);
    });
    const { notify } = makeNotify();
    const stats = await runNoResponseHandoffs({ supabaseUrl: URL_BASE, serviceKey: KEY, now: NOW_AFTER_4H, env: ENV_ON, fetchImpl: failing, notify });
    expect(notify).not.toHaveBeenCalled();
    expect(stats.skipped[0].reason).toBe('evidence_read_failed');
  });

  it('15. any existing no_response decision (kept waiting, delivered, failed) blocks recreation', () => {
    const task = stalledTask();
    for (const d of [
      { status: 'answered', owner_notification_status: 'sent', owner_notified_at: 'x' },
      { status: 'delivered_to_staff', owner_notification_status: 'sent', owner_notified_at: 'x' },
      { status: 'failed', owner_notification_status: 'sent', owner_notified_at: 'x' },
      { status: 'open', owner_notification_status: 'sent', owner_notified_at: 'x' },
      { status: 'open', owner_notification_status: 'reconciliation_required', owner_notified_at: null },
    ]) {
      expect(evaluateNoResponseHandoff({
        task, cutover: DEPLOY_AT, now: NOW_AFTER_4H,
        evidence: { person: person(), staffReplyFound: false, contactReplyFound: false, decisions: [d] },
      }).reason).toBe('no_response_handoff_exists');
    }
  });

  it('an open decision whose owner notification failed is re-notified, never duplicated', () => {
    const v = evaluateNoResponseHandoff({
      task: stalledTask(), cutover: DEPLOY_AT, now: NOW_AFTER_4H,
      evidence: { person: person(), staffReplyFound: false, contactReplyFound: false,
        decisions: [{ status: 'open', owner_notification_status: 'failed', owner_notified_at: null }] },
    });
    expect(v).toEqual({ eligible: true, reason: null, retryNotification: true });
  });
});

// ── 13–17: owner choices ────────────────────────────────────────────────────

describe('KEEP WAITING', () => {
  it('14/15. records the truthful choice, sends nothing, leaves the task pending, keeps the row blocking recreation', async () => {
    const { row } = freshTaskWithDecision();
    const out = await exec(row, 'keep_waiting');
    expect(out).toEqual({ kind: 'success', status: 'kept_waiting', choice: 'keep_waiting' });
    const stored = db.staff_escalation_owner_decisions[0];
    expect(stored.status).toBe('answered');
    expect(stored.owner_reply_text).toBe(NO_RESPONSE_CHOICES.keep_waiting);
    expect(stored.answered_at).toBeTruthy();
    expect(db.rpcCalls.map((c) => c.name)).toEqual(['answer_escalation_owner_decision']);
    expect(deliveryMocks.beginWhatsappDelivery).not.toHaveBeenCalled();
    expect(db.writes).toHaveLength(0);
    expect(db.tasks[0]).toMatchObject({ status: 'pending', confirmed_at: null, dismissed_at: null, archived_at: null });

    // Protected by the task-only-open index: the claim RPC returns this row, never a new one.
    const again = rpc(db, 'claim_task_escalation_owner_decision', { p_task_id: 'task-fresh', p_user_id: OWNER, p_review_type: 'no_response' });
    expect(again.id).toBe(stored.id);
    expect(db.staff_escalation_owner_decisions).toHaveLength(1);
  });

  it('a repeated KEEP WAITING submission is a no-op', async () => {
    const { row } = freshTaskWithDecision();
    await exec(row, 'keep_waiting');
    const second = await exec(db.staff_escalation_owner_decisions[0], 'keep_waiting');
    expect(second.status).toBe('kept_waiting');
    expect(deliveryMocks.beginWhatsappDelivery).not.toHaveBeenCalled();
  });
});

describe('ASK AGAIN', () => {
  const okSend = () => vi.fn(async () => ({ ok: true, messageId: 'wamid.reask' }));

  it('13. sends exactly one re-ask, records delivery evidence, leaves the task pending with confirmed_at NULL', async () => {
    const { row } = freshTaskWithDecision();
    const sendImpl = okSend();
    const out = await exec(row, 'ask_again', { sendImpl });
    expect(out).toMatchObject({ kind: 'success', status: 'delivered', transportMessageId: 'wamid.reask' });
    expect(sendImpl).toHaveBeenCalledTimes(1);
    const stored = db.staff_escalation_owner_decisions[0];
    expect(stored.status).toBe('delivered_to_staff');
    expect(stored.owner_reply_text).toBe('Ask again');
    expect(stored.delivery_transport_message_id).toBe('wamid.reask');
    expect(deliveryMocks.markWhatsappDeliveryAccepted).toHaveBeenCalledWith(expect.objectContaining({ metaMessageId: 'wamid.reask' }));
    expect(db.writes).toHaveLength(0);
    expect(db.tasks[0]).toMatchObject({ status: 'pending', confirmed_at: null });
    const payload = JSON.stringify(sendImpl.mock.calls[0][0].payload);
    expect(payload).toContain('Christopher');
    expect(payload).toContain('call Sana now');
    expect(payload).toContain('https://www.ra7etbal.com/confirm?task=task-fresh');
  });

  it('repeated owner submission never duplicates the send', async () => {
    const { row } = freshTaskWithDecision();
    const sendImpl = okSend();
    await exec(row, 'ask_again', { sendImpl });
    const again = await exec(db.staff_escalation_owner_decisions[0], 'ask_again', { sendImpl });
    expect(again.status).toBe('delivered');
    expect(sendImpl).toHaveBeenCalledTimes(1);
  });

  it('concurrent owner submissions send at most once', async () => {
    const { row } = freshTaskWithDecision();
    const sendImpl = okSend();
    const outs = await Promise.all([exec(row, 'ask_again', { sendImpl }), exec(row, 'ask_again', { sendImpl }), exec(row, 'ask_again', { sendImpl })]);
    expect(sendImpl).toHaveBeenCalledTimes(1);
    expect(outs.every((o) => o.kind === 'success')).toBe(true);
  });

  it('first write wins: KEEP WAITING then ASK AGAIN never sends', async () => {
    const { row } = freshTaskWithDecision();
    const sendImpl = okSend();
    await exec(row, 'keep_waiting');
    const out = await exec(row, 'ask_again', { sendImpl });
    expect(out.status).toBe('kept_waiting');
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('16. late completion defeats a pending ASK AGAIN — nothing is sent', async () => {
    const { row, task } = freshTaskWithDecision();
    const sendImpl = okSend();
    // Completion lands after the owner answered but before delivery.
    const racing = vi.fn(async (url, init) => {
      const res = await fetchImpl(url, init);
      if (String(url).includes('answer_escalation_owner_decision')) task.status = 'done';
      return res;
    });
    const out = await executeNoResponseChoice({
      supabaseUrl: URL_BASE, serviceKey: KEY, userId: OWNER, decisionRow: { ...row }, choice: 'ask_again',
      fetchImpl: racing, sendImpl, env: { WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'pn' },
    });
    expect(out).toMatchObject({ kind: 'success', status: 'not_sent_no_longer_current', reason: 'status_done' });
    expect(sendImpl).not.toHaveBeenCalled();
    expect(db.rpcCalls.map((c) => c.name)).not.toContain('claim_escalation_answer_delivery');
  });

  it('17. a late staff reply defeats a pending ASK AGAIN — nothing is sent', async () => {
    const { row, task } = freshTaskWithDecision();
    const sendImpl = okSend();
    const racing = vi.fn(async (url, init) => {
      const res = await fetchImpl(url, init);
      if (String(url).includes('answer_escalation_owner_decision')) {
        db.staff_messages.push({ id: 'late', user_id: OWNER, person_id: 'person-chris', staff_phone: null, received_at: NOW_AFTER_4H.toISOString() });
      }
      return res;
    });
    const out = await executeNoResponseChoice({
      supabaseUrl: URL_BASE, serviceKey: KEY, userId: OWNER, decisionRow: { ...row }, choice: 'ask_again',
      fetchImpl: racing, sendImpl, env: { WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'pn' },
    });
    expect(out.status).toBe('not_sent_no_longer_current');
    expect(out.reason).toBe('staff_replied');
    expect(sendImpl).not.toHaveBeenCalled();
    expect(task.status).toBe('pending');
  });

  it('a terminal task at choice time records nothing and sends nothing', async () => {
    const { row } = freshTaskWithDecision({}, { status: 'done' });
    const sendImpl = okSend();
    for (const choice of ['ask_again', 'keep_waiting']) {
      const out = await exec(row, choice, { sendImpl });
      expect(out).toEqual({ kind: 'not_current', reason: 'status_done' });
    }
    expect(db.staff_escalation_owner_decisions[0].status).toBe('open');
    expect(db.rpcCalls).toHaveLength(0);
    expect(sendImpl).not.toHaveBeenCalled();
  });

  it('an unreachable assignee is reported truthfully and nothing is sent', async () => {
    db.people = [person({ whatsapp_opted_in: false })];
    const { row } = freshTaskWithDecision();
    const sendImpl = okSend();
    const out = await exec(row, 'ask_again', { sendImpl });
    expect(out.status).toBe('saved_unreachable');
    expect(sendImpl).not.toHaveBeenCalled();
    expect(db.staff_escalation_owner_decisions[0].status).toBe('failed');
  });

  it('a failed send can be retried by the owner and still sends only once in total', async () => {
    const { row } = freshTaskWithDecision();
    const failingSend = vi.fn(async () => ({ ok: false, status: 400 }));
    expect((await exec(row, 'ask_again', { sendImpl: failingSend })).kind).toBe('send_error');
    expect(db.staff_escalation_owner_decisions[0].status).toBe('failed');
    const sendImpl = okSend();
    const retry = await exec(db.staff_escalation_owner_decisions[0], undefined, { sendImpl });
    expect(retry.status).toBe('delivered');
    expect(sendImpl).toHaveBeenCalledTimes(1);
  });
});

describe('choice contract', () => {
  it('rejects approve / reject / custom vocabulary for no_response', async () => {
    const { row } = freshTaskWithDecision();
    for (const choice of ['approved', 'rejected', 'custom_instruction', undefined]) {
      const out = await exec(row, choice);
      expect(out.kind).toBe('validation_error');
    }
    expect(db.rpcCalls).toHaveLength(0);
  });

  it('refuses to execute a non-no_response or staff-message-backed decision', async () => {
    const { row } = freshTaskWithDecision();
    for (const bad of [{ review_type: 'substitute_review' }, { review_type: 'staff_escalation' }, { staff_message_id: 'sm-1' }]) {
      const out = await exec({ ...row, ...bad }, 'ask_again');
      expect(out.kind).toBe('validation_error');
    }
  });
});

describe('copy truthfulness', () => {
  it('owner message states only verified facts and carries the decision link', () => {
    const msg = buildNoResponseOwnerMessage({
      taskDescription: 'call me now.', assignedTo: 'Christopher', deepLinkUrl: buildNoResponseDeepLink('tok-1'),
    });
    expect(msg).toBe(
      'Christopher hasn\'t replied about "call me now." since Carson followed up. Should I ask Christopher again, or keep waiting? Choose here: https://www.ra7etbal.com/confirm?task=tok-1',
    );
    expect(msg).not.toMatch(/approve|reject|said|replied:/i);
  });

  it('re-ask message names the real task and links to its confirmation page', () => {
    expect(buildNoResponseReaskMessage({
      assignedTo: 'Christopher', taskDescription: 'call me now.', ownerName: 'Sana', confirmationUrl: 'https://x/confirm?task=1',
    })).toBe("Hi Christopher, checking in again about: call Sana now. Please confirm here when it's done: https://x/confirm?task=1");
  });

  it('current-state block is null only for a genuinely silent, current delegation', () => {
    const ev = { person: person(), staffReplyFound: false, contactReplyFound: false };
    expect(getNoResponseCurrentStateBlock(stalledTask(), ev)).toBeNull();
    expect(getNoResponseCurrentStateBlock(stalledTask({ followup_sent_at: null }), ev)).toBe('followup_not_sent');
    expect(getNoResponseCurrentStateBlock(stalledTask({ type: 'reminder', needs_follow_up: false }), ev)).toBe('not_delegated');
    expect(getNoResponseCurrentStateBlock(null, ev)).toBe('task_not_found');
  });
});

describe('migration scope', () => {
  const dir = join(process.cwd(), 'supabase/migrations');
  const up = readFileSync(join(dir, '20260928_escalation_review_type_no_response.sql'), 'utf8');
  const down = readFileSync(join(dir, '20260928_escalation_review_type_no_response.rollback.sql'), 'utf8');
  const code = (sql) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

  it('only widens the review_type CHECK and the RPC allow-list with no_response', () => {
    const body = code(up);
    expect(body).toMatch(/'staff_escalation'::text, 'uncertain_proof'::text,\s*'substitute_review'::text, 'correction_limit'::text,\s*'no_response'::text/);
    expect(body).toMatch(/IN \('uncertain_proof', 'substitute_review', 'correction_limit', 'staff_escalation', 'no_response'\)/);
    expect(body).toMatch(/SECURITY DEFINER/);
    expect(body).toMatch(/SET search_path TO 'pg_catalog', 'public'/);
    expect(body).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(body).toMatch(/ON CONFLICT DO NOTHING/);
    expect(body).not.toMatch(/\bUPDATE\s+public\.|DELETE FROM|INSERT INTO public\.tasks|CREATE INDEX|DROP INDEX|POLICY|ADD COLUMN|DROP COLUMN|ALTER COLUMN/i);
    // Only one ALTER TABLE, and it touches only the review_type CHECK.
    expect(body.match(/ALTER TABLE/g)).toHaveLength(1);
    expect(body.match(/DROP CONSTRAINT (\w+)/)[1]).toBe('staff_escalation_owner_decisions_review_type_check');
  });

  it('rollback restores the prior definitions and refuses to run while no_response rows exist', () => {
    const body = code(down);
    expect(body).toMatch(/rollback_blocked/);
    expect(body).toMatch(/'correction_limit'::text\]\)\)/);
    expect(body).toMatch(/IN \('uncertain_proof', 'substitute_review', 'correction_limit', 'staff_escalation'\)/);
    expect(body).not.toMatch(/'staff_escalation', 'no_response'/);
    expect(body).not.toMatch(/'no_response'::text/);
    expect(body).not.toMatch(/DELETE FROM/i);
  });
});
