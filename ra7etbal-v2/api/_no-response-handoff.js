/**
 * Chief-of-Staff Lifecycle Slice 1 — stalled tracked delegation → owner
 * handoff (review_type 'no_response') → owner chooses ASK AGAIN or KEEP
 * WAITING → truthful execution. The task stays pending until real completion.
 *
 * Owner-authorized 2026-09-27 ("AUTHORIZED — SLICE 1 DECISIONS RESOLVED").
 *
 * ── Rollout gate (inert by default) ─────────────────────────────────────────
 * NO_RESPONSE_HANDOFF_CUTOVER_AT is a single explicit cutover timestamp for
 * THIS lifecycle feature only. Unset, blank or unparseable → the sweep stage
 * does nothing at all (no query, no decision, no notification, no message).
 * When set, only escalations whose escalated_at is at or after the cutover
 * participate. Escalations created before the cutover — including every
 * historical stalled delegation in Production — never participate
 * automatically. There is no age ceiling and no per-task special case.
 *
 * ── Timing ─────────────────────────────────────────────────────────────────
 * NO_RESPONSE_HANDOFF_DELAY_MS (4 hours after escalated_at) is an OWNER
 * PRODUCT DECISION. It is not derived from PROD_FOLLOWUP_MS /
 * PROD_ESCALATE_MS or any other existing timing convention.
 *
 * ── What "no response" means here (fail-safe) ──────────────────────────────
 * Carson only tells the owner "X hasn't replied" when every one of these is
 * verified from Postgres at that moment: the task is still pending, not
 * archived/dismissed/confirmed; the existing follow-up and escalation both
 * happened; no proof was submitted (quality review block); tasks.worker_reply
 * is empty; the assignee resolves to exactly one person; and that person has
 * no staff_messages / personal_contact_replies row since the task was
 * created. Any unresolvable fact suppresses the handoff rather than risking
 * an untrue "hasn't replied".
 *
 * ── Owner choices ──────────────────────────────────────────────────────────
 * Both go through the existing staff_escalation_owner_decisions state machine
 * (answer_escalation_owner_decision is first-write-wins; the delivery lease
 * claim_escalation_answer_delivery makes a send happen at most once).
 *   KEEP WAITING → answer RPC only: status 'answered', owner_reply_text
 *     'Keep waiting'. No staff message. The row stays inside the task-only
 *     open partial unique index, which blocks recreation. Re-offer after
 *     keep-waiting is OPEN lifecycle work and deliberately not solved here.
 *   ASK AGAIN → answer RPC ('Ask again') → re-check current task state →
 *     claim delivery lease → one direct WhatsApp re-ask to the assignee →
 *     complete with the Meta message id. The task stays pending and
 *     confirmed_at is never written.
 * No background path ever sends the re-ask: only an owner submission does.
 */

import { sendMetaMessage, buildDirectMessagePayload, normalizeWhatsAppPhone } from './send-whatsapp-task.js';
import { resolveOwnerPerspective } from '../shared/owner-perspective.js';
import { beginWhatsappDelivery, markWhatsappDeliveryAccepted, markWhatsappDeliveryFailed, getMetaFailure } from './_whatsapp-delivery.js';

export const NO_RESPONSE_REVIEW_TYPE = 'no_response';
/** OWNER PRODUCT DECISION (2026-09-27) — see file header. */
export const NO_RESPONSE_HANDOFF_DELAY_MS = 4 * 60 * 60 * 1000;
export const NO_RESPONSE_CUTOVER_ENV = 'NO_RESPONSE_HANDOFF_CUTOVER_AT';
/** Max tasks whose reply evidence is read (and may be notified) per run. */
export const NO_RESPONSE_MAX_TASKS_PER_RUN = 20;
/** Candidate scan is paged so already-handled tasks can never starve newer ones. */
export const NO_RESPONSE_SCAN_PAGE_SIZE = 100;
export const NO_RESPONSE_MAX_SCAN_ROWS = 1000;

export const NO_RESPONSE_CHOICES = Object.freeze({
  ask_again: 'Ask again',
  keep_waiting: 'Keep waiting',
});

const CANONICAL_APP_BASE_URL = 'https://www.ra7etbal.com';

export function readNoResponseCutover(env = process.env) {
  const raw = String(env?.[NO_RESPONSE_CUTOVER_ENV] ?? '').trim();
  if (!raw) return null;
  // Require an explicit ISO-8601 instant so a typo can never silently widen
  // the population (Date.parse accepts many loose formats).
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function buildNoResponseDeepLink(deepLinkToken) {
  return `${CANONICAL_APP_BASE_URL}/confirm?task=${encodeURIComponent(deepLinkToken)}`;
}

/** Owner-facing handoff copy. States only verified facts; never implies a reply. */
export function buildNoResponseOwnerMessage({ taskDescription, assignedTo, deepLinkUrl }) {
  const task = String(taskDescription || 'a task').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  const who = String(assignedTo || 'The assignee').replace(/[\r\n\t]+/g, ' ').trim();
  const link = deepLinkUrl ? ` Choose here: ${deepLinkUrl}` : '';
  return `${who} hasn't replied about "${task}" since Carson followed up. Should I ask ${who} again, or keep waiting?${link}`;
}

/**
 * Staff-facing re-ask. Neutral, no invented context; links to the real task.
 * The stored task description is a task record from the owner's side; it is
 * rendered for the assignee through the single owner-perspective contract
 * (shared/owner-perspective.js). When that cannot be done safely the re-ask
 * does not quote the task at all rather than guess who "I" or "her" means.
 */
export function buildNoResponseReaskMessage({ assignedTo, taskDescription, ownerName, confirmationUrl }) {
  const who = String(assignedTo || '').replace(/[\r\n\t]+/g, ' ').trim();
  const owner = (typeof ownerName === 'string' && ownerName.trim()) ? ownerName.trim() : 'the sender';
  const greeting = who ? `Hi ${who}, checking` : 'Checking';
  const resolved = resolveOwnerPerspective(String(taskDescription || '').replace(/[\r\n\t]+/g, ' ').trim(), {
    ownerName: owner, recipientName: who || null, voice: 'task_record',
  });
  if (resolved.status === 'needs_composition') {
    return `${greeting} in again about the task ${owner} sent you. Please confirm here when it's done: ${confirmationUrl}`;
  }
  const task = resolved.text.replace(/[\s.!?]+$/, '');
  return `${greeting} in again about: ${task}. Please confirm here when it's done: ${confirmationUrl}`;
}

/**
 * Pure. Is the task still a CURRENT, unresolved, silent tracked delegation?
 * Returns null when current, otherwise the reason it is not. Used both before
 * the handoff is created and again immediately before any owner choice is
 * executed ("late completion wins", "relevant staff reply wins").
 */
export function getNoResponseCurrentStateBlock(task, evidence) {
  if (!task) return 'task_not_found';
  if (task.status !== 'pending') return `status_${task.status}`;
  if (task.archived_at) return 'archived';
  if (task.dismissed_at) return 'dismissed';
  if (task.confirmed_at) return 'confirmed';
  if (!task.assigned_to || !String(task.assigned_to).trim()) return 'no_assignee';
  const isDelegated = task.type === 'delegation' || task.type === 'followup' || task.needs_follow_up === true;
  if (!isDelegated) return 'not_delegated';
  const qi = typeof task.quality_review_status === 'string' ? task.quality_review_status.trim().toLowerCase() : '';
  if (qi && qi !== 'approved') return `quality_review_${qi}`;
  if (task.proof_image_path) return 'proof_submitted';
  if (!task.followup_sent_at) return 'followup_not_sent';
  if (!task.escalated_at) return 'not_escalated';
  if (typeof task.worker_reply === 'string' && task.worker_reply.trim()) return 'worker_replied';
  if (!evidence) return 'evidence_unavailable';
  if (!evidence.person) return 'assignee_unresolved';
  if (evidence.staffReplyFound) return 'staff_replied';
  if (evidence.contactReplyFound) return 'contact_replied';
  return null;
}

/**
 * Pure. The full sweep predicate. Returns { eligible, reason, retryNotification }.
 * retryNotification: an existing open no_response decision whose owner
 * notification never went out (NULL/failed) may be re-notified; any other
 * existing no_response decision — in ANY status — blocks a new handoff.
 */
export function evaluateNoResponseHandoff({ task, evidence, cutover, now }) {
  if (!cutover) return { eligible: false, reason: 'cutover_unset' };
  if (!task?.escalated_at) return { eligible: false, reason: 'not_escalated' };
  const escalatedMs = Date.parse(task.escalated_at);
  if (!Number.isFinite(escalatedMs)) return { eligible: false, reason: 'not_escalated' };
  if (escalatedMs < cutover.getTime()) return { eligible: false, reason: 'pre_cutover' };
  if (now.getTime() - escalatedMs < NO_RESPONSE_HANDOFF_DELAY_MS) return { eligible: false, reason: 'handoff_delay_not_reached' };

  const block = getNoResponseCurrentStateBlock(task, evidence);
  if (block) return { eligible: false, reason: block };

  const decisions = Array.isArray(evidence?.decisions) ? evidence.decisions : [];
  if (decisions.length === 0) return { eligible: true, reason: null, retryNotification: false };
  return isRetryableNotification(decisions)
    ? { eligible: true, reason: null, retryNotification: true }
    : { eligible: false, reason: 'no_response_handoff_exists' };
}

/** One open no_response decision whose owner notification never went out. */
export function isRetryableNotification(decisions) {
  return decisions.length === 1 &&
    decisions[0].status === 'open' &&
    (decisions[0].owner_notification_status == null || decisions[0].owner_notification_status === 'failed') &&
    !decisions[0].owner_notified_at;
}

// ── Postgres reads (service role) ────────────────────────────────────────────

export const NO_RESPONSE_TASK_COLUMNS =
  'id,user_id,type,description,assigned_to,assigned_person_id,status,needs_follow_up,created_at,' +
  'followup_sent_at,escalated_at,confirmed_at,dismissed_at,archived_at,quality_review_status,' +
  'proof_image_path,worker_reply';

function headersFor(serviceKey) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

async function restGet(fetchImpl, supabaseUrl, serviceKey, path) {
  const res = await fetchImpl(`${supabaseUrl}/rest/v1/${path}`, { headers: headersFor(serviceKey) });
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body)) {
    throw new Error(`no_response_read_failed:${path.split('?')[0]}:${res.status}`);
  }
  return body;
}

export async function fetchNoResponseTask({ supabaseUrl, serviceKey, fetchImpl = fetch, taskId, userId }) {
  const rows = await restGet(fetchImpl, supabaseUrl, serviceKey,
    `tasks?id=eq.${encodeURIComponent(taskId)}&user_id=eq.${encodeURIComponent(userId)}` +
      `&select=${NO_RESPONSE_TASK_COLUMNS}&limit=2`);
  return rows.length === 1 ? rows[0] : null;
}

/**
 * Reads everything the predicate needs. Throws on any read failure so the
 * caller fails closed (no handoff, no send) instead of treating "could not
 * read replies" as "no replies".
 */
export async function fetchNoResponseEvidence({ supabaseUrl, serviceKey, fetchImpl = fetch, task, decisions: prefetchedDecisions }) {
  const userQ = `user_id=eq.${encodeURIComponent(task.user_id)}`;
  const personPath = task.assigned_person_id
    ? `people?id=eq.${encodeURIComponent(task.assigned_person_id)}&${userQ}&select=id,name,phone,whatsapp_opted_in&limit=2`
    : task.assigned_to
      ? `people?${userQ}&name=ilike.${encodeURIComponent(String(task.assigned_to).trim())}&select=id,name,phone,whatsapp_opted_in&limit=2`
      : null;

  // Independent reads run in parallel; any failure rejects (fail closed).
  const [personRows, decisions] = await Promise.all([
    personPath ? restGet(fetchImpl, supabaseUrl, serviceKey, personPath) : Promise.resolve([]),
    Array.isArray(prefetchedDecisions)
      ? Promise.resolve(prefetchedDecisions)
      : restGet(fetchImpl, supabaseUrl, serviceKey,
        `staff_escalation_owner_decisions?task_id=eq.${encodeURIComponent(task.id)}&${userQ}` +
          `&review_type=eq.${NO_RESPONSE_REVIEW_TYPE}&select=id,task_id,status,owner_notification_status,owner_notified_at&limit=5`),
  ]);
  const person = personRows.length === 1 ? personRows[0] : null;

  let staffReplyFound = false;
  let contactReplyFound = false;
  if (person) {
    const since = encodeURIComponent(task.created_at);
    const staffOr = [`person_id.eq.${person.id}`];
    if (person.phone) staffOr.push(`staff_phone.eq.${encodeURIComponent(person.phone)}`);
    const [staffRows, contactRows] = await Promise.all([
      restGet(fetchImpl, supabaseUrl, serviceKey,
        `staff_messages?${userQ}&received_at=gte.${since}&or=(${staffOr.join(',')})&select=id&limit=1`),
      restGet(fetchImpl, supabaseUrl, serviceKey,
        `personal_contact_replies?${userQ}&person_id=eq.${encodeURIComponent(person.id)}&created_at=gte.${since}&select=id&limit=1`),
    ]);
    staffReplyFound = staffRows.length > 0;
    contactReplyFound = contactRows.length > 0;
  }

  return { person, staffReplyFound, contactReplyFound, decisions };
}

// ── Sweep stage ──────────────────────────────────────────────────────────────

/**
 * Called from the existing 10-minute QStash sweep. Inert unless the cutover
 * env value is set. Only creates the owner handoff (decision row + one owner
 * notification via notifyOwnerOfTaskReview); it NEVER messages staff.
 */
export async function runNoResponseHandoffs({ supabaseUrl, serviceKey, now = new Date(), env = process.env, fetchImpl = fetch, notify }) {
  const cutover = readNoResponseCutover(env);
  if (!cutover) return { enabled: false, checked: 0, notified: 0 };

  const latestEscalation = new Date(now.getTime() - NO_RESPONSE_HANDOFF_DELAY_MS).toISOString();
  const stats = {
    enabled: true, cutover: cutover.toISOString(), scanned: 0, alreadyHandedOff: 0,
    checked: 0, notified: 0, saturated: false, skipped: [],
  };

  // Page through ALL post-cutover candidates. Tasks that already have a
  // no_response decision stay pending (Keep waiting, delivered Ask again), so
  // a single oldest-first window would fill with them and starve newer
  // stalls — the 41770f40 shape. They are dropped per page with one batched
  // decision read before any per-task evidence is fetched.
  const candidates = [];
  for (let offset = 0; ; offset += NO_RESPONSE_SCAN_PAGE_SIZE) {
    if (offset >= NO_RESPONSE_MAX_SCAN_ROWS) {
      stats.saturated = true;
      console.error('[no-response] candidate scan saturated — newer stalls may be starved', { scanned: stats.scanned });
      break;
    }
    const page = await restGet(fetchImpl, supabaseUrl, serviceKey,
      `tasks?status=eq.pending&archived_at=is.null&dismissed_at=is.null&confirmed_at=is.null` +
        `&assigned_to=not.is.null&followup_sent_at=not.is.null` +
        `&escalated_at=gte.${encodeURIComponent(cutover.toISOString())}` +
        `&escalated_at=lte.${encodeURIComponent(latestEscalation)}` +
        `&select=${NO_RESPONSE_TASK_COLUMNS}&order=escalated_at.asc,id.asc` +
        `&limit=${NO_RESPONSE_SCAN_PAGE_SIZE}&offset=${offset}`);
    stats.scanned += page.length;
    if (page.length > 0) {
      const decisionRows = await restGet(fetchImpl, supabaseUrl, serviceKey,
        `staff_escalation_owner_decisions?task_id=in.(${page.map((t) => encodeURIComponent(t.id)).join(',')})` +
          `&review_type=eq.${NO_RESPONSE_REVIEW_TYPE}` +
          `&select=id,task_id,status,owner_notification_status,owner_notified_at`);
      for (const task of page) {
        const decisions = decisionRows.filter((d) => d.task_id === task.id);
        if (decisions.length > 0 && !isRetryableNotification(decisions)) {
          stats.alreadyHandedOff += 1;
          continue;
        }
        candidates.push({ task, decisions });
      }
    }
    if (page.length < NO_RESPONSE_SCAN_PAGE_SIZE) break;
  }

  for (const { task, decisions } of candidates.slice(0, NO_RESPONSE_MAX_TASKS_PER_RUN)) {
    stats.checked += 1;
    let evidence;
    try {
      evidence = await fetchNoResponseEvidence({ supabaseUrl, serviceKey, fetchImpl, task, decisions });
    } catch (err) {
      stats.skipped.push({ taskId: task.id, reason: 'evidence_read_failed' });
      console.error('[no-response] evidence read failed (fail closed)', { taskId: task.id, error: err?.message });
      continue;
    }
    const verdict = evaluateNoResponseHandoff({ task, evidence, cutover, now });
    if (!verdict.eligible) {
      stats.skipped.push({ taskId: task.id, reason: verdict.reason });
      continue;
    }
    const result = await notify({
      taskId: task.id,
      userId: task.user_id,
      reviewType: NO_RESPONSE_REVIEW_TYPE,
      taskDescription: task.description,
      assignedTo: task.assigned_to,
      reviewNote: null,
      proofImagePath: null,
    }).catch((err) => ({ status: 'failed', reason: err?.message || String(err) }));
    console.log('[no-response] owner handoff', {
      taskId: task.id, retryNotification: verdict.retryNotification, status: result?.status, reason: result?.reason || null,
    });
    if (result?.status === 'sent') stats.notified += 1;
  }
  if (candidates.length > NO_RESPONSE_MAX_TASKS_PER_RUN) {
    console.warn('[no-response] more candidates than one run evaluates; the rest wait for the next run', {
      candidates: candidates.length, perRun: NO_RESPONSE_MAX_TASKS_PER_RUN,
    });
  }
  return stats;
}

// ── Owner choice execution ──────────────────────────────────────────────────

async function rpc(fetchImpl, supabaseUrl, serviceKey, fnName, args) {
  const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${fnName}`, {
    method: 'POST', headers: headersFor(serviceKey), body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: { message: body?.message || `rpc_${fnName}_${res.status}`, code: body?.code || null } };
  return { data: Array.isArray(body) ? body : body };
}

function persistedChoice(replyText) {
  const text = String(replyText || '').trim();
  if (text === NO_RESPONSE_CHOICES.ask_again) return 'ask_again';
  if (text === NO_RESPONSE_CHOICES.keep_waiting) return 'keep_waiting';
  return null;
}

async function resolveOwnerName(fetchImpl, supabaseUrl, serviceKey, userId) {
  try {
    const rows = await restGet(fetchImpl, supabaseUrl, serviceKey,
      `profiles?id=eq.${encodeURIComponent(userId)}&select=display_name&limit=1`);
    const name = rows[0]?.display_name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Executes the owner's choice on an ownership-verified no_response decision.
 * `decisionRow` needs id, user_id, task_id, review_type, status,
 * owner_reply_text, deep_link_token. `choice` is 'ask_again' | 'keep_waiting'
 * (ignored when an answer is already persisted — first write wins).
 *
 * Result kinds:
 *   { kind: 'validation_error', message }
 *   { kind: 'not_current', reason }            — task finished/replied; nothing written or sent
 *   { kind: 'rpc_error', error }
 *   { kind: 'success', status, choice }        — status:
 *       'kept_waiting' | 'delivered' | 'in_progress' | 'saved_unreachable' |
 *       'sent_unconfirmed' | 'not_sent_no_longer_current' |
 *       'sent_then_superseded' (Meta accepted the re-ask, then newer same-task
 *       proof superseded the decision before completion was recorded — the
 *       send is real and its whatsapp_deliveries evidence is kept)
 *   { kind: 'send_error' } | { kind: 'config_error', message }
 *
 * A 'superseded' decision (newer same-task proof won; see
 * 20260929_no_response_superseded_by_proof.sql) is never actionable:
 * { kind: 'not_current', reason: 'superseded' }, nothing written or sent.
 */
export async function executeNoResponseChoice({
  supabaseUrl, serviceKey, userId, decisionRow, choice, replyChannel = 'app', fetchImpl = fetch,
  sendImpl = sendMetaMessage, env = process.env,
}) {
  if (decisionRow?.review_type !== NO_RESPONSE_REVIEW_TYPE || decisionRow.staff_message_id || !decisionRow.task_id) {
    return { kind: 'validation_error', message: 'This decision is not a no-response handoff.' };
  }
  if (decisionRow.status === 'superseded') {
    return { kind: 'not_current', reason: 'superseded' };
  }
  const readRowStatus = async () => {
    const rows = await restGet(fetchImpl, supabaseUrl, serviceKey,
      `staff_escalation_owner_decisions?id=eq.${encodeURIComponent(decisionRow.id)}` +
        `&user_id=eq.${encodeURIComponent(userId)}&select=status&limit=1`);
    return rows[0]?.status || null;
  };
  const readState = async () => {
    const task = await fetchNoResponseTask({ supabaseUrl, serviceKey, fetchImpl, taskId: decisionRow.task_id, userId });
    const evidence = task ? await fetchNoResponseEvidence({ supabaseUrl, serviceKey, fetchImpl, task }) : null;
    return { task, evidence, block: getNoResponseCurrentStateBlock(task, evidence) };
  };

  let row = decisionRow;
  let persisted = persistedChoice(row.owner_reply_text);

  if (row.status === 'open') {
    if (!Object.hasOwn(NO_RESPONSE_CHOICES, choice)) {
      return { kind: 'validation_error', message: 'Choose Ask again or Keep waiting.' };
    }
    let state;
    try {
      state = await readState();
    } catch {
      return { kind: 'not_current', reason: 'state_unavailable' };
    }
    if (state.block) return { kind: 'not_current', reason: state.block };
    const answer = await rpc(fetchImpl, supabaseUrl, serviceKey, 'answer_escalation_owner_decision', {
      p_deep_link_token: row.deep_link_token,
      p_owner_reply_text: NO_RESPONSE_CHOICES[choice],
      p_owner_reply_channel: replyChannel,
    });
    if (answer.error) {
      // The answer RPC refuses a row that newer same-task proof superseded
      // between our read and this write — report that truthfully.
      const nowStatus = await readRowStatus().catch(() => null);
      if (nowStatus === 'superseded') return { kind: 'not_current', reason: 'superseded' };
      return { kind: 'rpc_error', error: answer.error };
    }
    const answered = Array.isArray(answer.data) ? answer.data[0] : answer.data;
    row = { ...row, ...answered };
    persisted = persistedChoice(row.owner_reply_text);
  }

  if (persisted === 'keep_waiting') {
    return { kind: 'success', status: 'kept_waiting', choice: 'keep_waiting' };
  }
  if (persisted !== 'ask_again') {
    return { kind: 'validation_error', message: 'This decision has no recognised answer.' };
  }
  if (row.status === 'delivered_to_staff') {
    return { kind: 'success', status: 'delivered', choice: 'ask_again' };
  }

  // Late completion / late reply / terminal task wins over a pending re-ask.
  let state;
  try {
    state = await readState();
  } catch {
    return { kind: 'not_current', reason: 'state_unavailable' };
  }
  if (state.block) {
    return { kind: 'success', status: 'not_sent_no_longer_current', choice: 'ask_again', reason: state.block };
  }

  const claimRes = await rpc(fetchImpl, supabaseUrl, serviceKey, 'claim_escalation_answer_delivery', {
    p_id: row.id, p_user_id: userId, p_lease_seconds: 120,
  });
  if (claimRes.error) return { kind: 'rpc_error', error: claimRes.error };
  const claim = Array.isArray(claimRes.data) ? claimRes.data[0] : claimRes.data;
  if (!claim?.claimed) {
    // Newer same-task proof superseded the decision after the answer was
    // saved: nothing was sent and nothing will be — never "in progress".
    if (claim?.delivery_status === 'superseded') {
      return { kind: 'success', status: 'not_sent_no_longer_current', choice: 'ask_again', reason: 'superseded' };
    }
    return {
      kind: 'success',
      status: claim?.delivery_status === 'delivered_to_staff' ? 'delivered' : 'in_progress',
      choice: 'ask_again',
    };
  }
  const fail = (reason) => rpc(fetchImpl, supabaseUrl, serviceKey, 'fail_escalation_answer_delivery', {
    p_id: row.id, p_user_id: userId, p_claim_token: claim.claim_token, p_error: reason,
  }).catch(() => null);

  const person = state.evidence.person;
  const normalizedPhone = person?.phone ? normalizeWhatsAppPhone(person.phone) : null;
  if (!normalizedPhone || !person.whatsapp_opted_in) {
    await fail('staff_unreachable');
    return { kind: 'success', status: 'saved_unreachable', choice: 'ask_again' };
  }

  const accessToken = env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID;
  if (!accessToken || !phoneNumberId) {
    await fail('whatsapp_not_configured');
    return { kind: 'config_error', message: 'WhatsApp is not configured.' };
  }

  const ownerName = await resolveOwnerName(fetchImpl, supabaseUrl, serviceKey, userId);
  const message = buildNoResponseReaskMessage({
    assignedTo: state.task.assigned_to,
    taskDescription: state.task.description,
    ownerName,
    confirmationUrl: `${CANONICAL_APP_BASE_URL}/confirm?task=${encodeURIComponent(state.task.id)}`,
  });
  const templateName = (env.WHATSAPP_DIRECT_MESSAGE_TEMPLATE || 'ra7etbal_direct_operational_message').trim();
  const templateLanguage = (env.WHATSAPP_DIRECT_MESSAGE_TEMPLATE_LANGUAGE || 'en').trim();
  // Last check before the irreversible external send: newer same-task proof
  // (which supersedes this row, even while 'delivering'), a late completion
  // or a late reply all win. Nothing is sent after this if any of them won.
  let preSendStatus;
  let preSendState;
  try {
    [preSendStatus, preSendState] = await Promise.all([readRowStatus(), readState()]);
  } catch {
    await fail('pre_send_state_unavailable');
    return { kind: 'not_current', reason: 'state_unavailable' };
  }
  if (preSendStatus !== 'delivering') {
    return {
      kind: 'success', status: 'not_sent_no_longer_current', choice: 'ask_again',
      reason: preSendStatus === 'superseded' ? 'superseded' : `decision_${preSendStatus}`,
    };
  }
  if (preSendState.block) {
    await fail(`not_sent_${preSendState.block}`);
    return { kind: 'success', status: 'not_sent_no_longer_current', choice: 'ask_again', reason: preSendState.block };
  }

  const deliveryMetadata = { escalation_id: row.id, task_id: state.task.id, review_type: NO_RESPONSE_REVIEW_TYPE, owner_choice: 'ask_again' };
  const deliveryId = await beginWhatsappDelivery({
    supabaseUrl, serviceKey, taskId: state.task.id, personId: person.id, sourceType: 'followup',
    recipientPhone: normalizedPhone, recipientName: state.task.assigned_to, templateName, metadata: deliveryMetadata,
  }).catch(() => null);
  if (!deliveryId) {
    // Same rule as notifyOwnerOfTaskReview: never send without an audit row.
    await fail('delivery_record_unavailable');
    return { kind: 'send_error' };
  }

  let sendResult;
  try {
    sendResult = await sendImpl({
      url: `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      accessToken,
      payload: buildDirectMessagePayload({ to: normalizedPhone, ownerName: 'Carson', message, templateName, templateLanguage }),
    });
  } catch (err) {
    await markWhatsappDeliveryFailed({ supabaseUrl, serviceKey, deliveryId, failureStage: 'network', reason: err?.message || String(err), templateName }).catch(() => {});
    await fail(err?.message || 'network_error');
    return { kind: 'send_error' };
  }
  if (!sendResult?.ok) {
    const failure = getMetaFailure(sendResult);
    await markWhatsappDeliveryFailed({ supabaseUrl, serviceKey, deliveryId, failureStage: 'meta_api', ...failure, templateName }).catch(() => {});
    await fail(failure.reason || 'meta_rejected');
    return { kind: 'send_error' };
  }

  await markWhatsappDeliveryAccepted({ supabaseUrl, serviceKey, deliveryId, metaMessageId: sendResult.messageId, templateName, metadata: deliveryMetadata }).catch(() => {});
  const complete = await rpc(fetchImpl, supabaseUrl, serviceKey, 'complete_escalation_answer_delivery', {
    p_id: row.id, p_user_id: userId, p_claim_token: claim.claim_token, p_transport_message_id: sendResult.messageId,
  });
  if (complete.error) {
    // Meta already accepted the re-ask. If newer same-task proof superseded
    // the decision in the meantime, say exactly that — the send happened and
    // its whatsapp_deliveries row (with this WAMID) is the evidence.
    const nowStatus = await readRowStatus().catch(() => null);
    console.error('[no-response] re-ask sent but completion bookkeeping failed', {
      decisionId: row.id, error: complete.error, decisionStatus: nowStatus,
    });
    return {
      kind: 'success',
      status: nowStatus === 'superseded' ? 'sent_then_superseded' : 'sent_unconfirmed',
      choice: 'ask_again',
      transportMessageId: sendResult.messageId,
    };
  }
  return { kind: 'success', status: 'delivered', choice: 'ask_again', transportMessageId: sendResult.messageId };
}
