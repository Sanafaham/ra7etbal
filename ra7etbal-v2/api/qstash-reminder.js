/**
 * POST /api/qstash-reminder
 *
 * Manages QStash delayed jobs for reminder push notifications.
 * The default HTTP handler below is called from the browser after task
 * mutations — never directly by QStash. This file also exports
 * scheduleAutomationRunWakeup, a server-only helper imported directly by
 * api/automations.js and api/process-delegation-escalations.js (not
 * reached via HTTP) to schedule exact-time wake-ups for recurring
 * automations. See its own doc comment for why this is a plain import
 * rather than another HTTP action: this file's HTTP handler authenticates
 * the caller as a signed-in end user and verifies task ownership, a model
 * that doesn't fit a server-to-server call with no originating end-user
 * request (automation creation and the automation runner both already
 * operate under the service role key, impersonating no one).
 *
 * Body: { action: 'schedule' | 'cancel' | 'reschedule' | 'create-and-schedule', taskId?, dueAt? }
 *
 * Auth: Supabase access token in Authorization: Bearer <token> header.
 *       Verified server-side; only the task owner may schedule/cancel.
 *
 * SAFETY NOTE: the 'schedule-escalation' action below, and
 * scheduleAutomationRunWakeup, only PUBLISH a timed wake-up call — neither
 * grants any authority. The receiving handler
 * (/api/process-delegation-escalations) always re-derives eligibility from
 * the database before doing anything, regardless of when or why it was
 * invoked. See process-delegation-escalations.js's own header for the full
 * rule and docs/SAFETY-duplicate-follow-up-prevention.md.
 */

import {
  CLIENT_RECEIPT_STAGES,
  recordDeliveryEvent,
  verifyReminderReceipt,
} from './_reminder-delivery.js';
import { safeBuildForLog, validateOneTimeRoutingEvidence } from './_one-time-routing-contract.js';

const QSTASH_BASE = 'https://qstash.upstash.io/v2';
// Exported so a test can assert these stay in lockstep with
// PROD_FOLLOWUP_MS / PROD_ESCALATE_MS in process-delegation-escalations.js —
// two independently-declared constants with nothing else enforcing they agree.
export const FOLLOWUP_DELAY_MS   = 10 * 60 * 1000; // 10 min
export const ESCALATION_DELAY_MS = 20 * 60 * 1000; // 20 min

/**
 * Unified QStash scheduling endpoint.
 *
 * Actions:
 *   schedule / cancel / reschedule  — reminder push jobs (existing)
 *   schedule-escalation             — follow-up + escalation jobs for delegation tasks (new)
 */
export default async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 8);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── 1. Env var check ────────────────────────────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const qstashToken = process.env.QSTASH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  const appBaseUrl = resolveAppBaseUrl();

  const missingVars = [];
  if (!supabaseUrl) missingVars.push('SUPABASE_URL');
  if (!serviceRoleKey) missingVars.push('SUPABASE_SERVICE_ROLE_KEY');
  if (req.body?.action !== 'notification-receipt' && !qstashToken) missingVars.push('QSTASH_TOKEN');

  if (missingVars.length > 0) {
    console.error(`[qstash-reminder][${requestId}] MISSING ENV VARS: ${missingVars.join(', ')}`);
    return res.status(500).json({
      success: false,
      error: `Server configuration error: missing ${missingVars.join(', ')}`,
    });
  }

  if (req.body?.action === 'notification-receipt') {
    return handleNotificationReceipt(req.body, res, {
      supabaseUrl, serviceRoleKey, secret: cronSecret, requestId,
    });
  }

  // ── 2. Verify caller is a signed-in Supabase user ──────────────────────────
  const authorization = req.headers.authorization || req.headers.Authorization || '';
  const userToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!userToken) {
    console.warn(`[qstash-reminder][${requestId}] missing authorization header`);
    return res.status(401).json({ success: false, error: 'Missing authorization token.' });
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${userToken}` },
  });
  if (!userRes.ok) {
    console.warn(`[qstash-reminder][${requestId}] JWT verify failed: ${userRes.status}`);
    return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
  }
  const userData = await userRes.json().catch(() => null);
  const userId = userData?.id;
  if (!userId) {
    console.warn(`[qstash-reminder][${requestId}] could not resolve userId from JWT`);
    return res.status(401).json({ success: false, error: 'Could not resolve user.' });
  }

  // ── 3. Parse and validate body ──────────────────────────────────────────────
  const body = req.body ?? {};
  const { action, taskId, dueAt, sentAt } = body;

  if (!action || (action !== 'create-and-schedule' && !taskId)) {
    return res.status(400).json({ success: false, error: 'action and taskId are required.' });
  }
  if ((action === 'schedule' || action === 'reschedule' || action === 'create-and-schedule') && !dueAt) {
    return res.status(400).json({ success: false, error: 'dueAt is required for schedule/reschedule.' });
  }
  if (action === 'schedule-escalation' && !sentAt) {
    return res.status(400).json({ success: false, error: 'sentAt is required for schedule-escalation.' });
  }

  if (action === 'create-and-schedule') {
    const routing = validateOneTimeRoutingEvidence(body.routingEvidence, 'owner_reminder');
    console.info('[qstash-reminder] routing decision', {
      requestId,
      taskId: null,
      toolInvoked: 'create_reminder',
      destination: body.routingEvidence?.destination ?? 'missing',
      reasonCode: routing.reasonCode,
      clientBuild: safeBuildForLog(body.routingEvidence),
    });
    if (!routing.valid || !routing.present) {
      return res.status(409).json({
        success: false,
        error: 'Routing contract rejected reminder creation.',
        reasonCode: routing.reasonCode,
      });
    }
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (!description) {
      return res.status(400).json({ success: false, error: 'description is required.' });
    }
    const dueMs = new Date(dueAt).getTime();
    if (Number.isNaN(dueMs)) {
      return res.status(400).json({ success: false, error: 'dueAt must be a valid ISO timestamp.' });
    }
    const taskIdForOperation = body.routingEvidence.operation_id;
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/tasks`, {
      method: 'POST',
      headers: { ...supabaseHeaders(serviceRoleKey), Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({
        id: taskIdForOperation,
        user_id: userId,
        description,
        type: 'reminder',
        assigned_to: null,
        assigned_person_id: null,
        status: 'pending',
        needs_follow_up: false,
        confirmation_url: null,
        due_at: new Date(dueMs).toISOString(),
      }),
    });
    const inserted = await insertRes.json().catch(() => null);
    let createdTask = Array.isArray(inserted) ? inserted[0] : null;
    if (!insertRes.ok) {
      console.error(`[qstash-reminder][${requestId}] routed reminder insert failed`, { status: insertRes.status });
      return res.status(500).json({ success: false, error: 'Failed to create reminder.' });
    }
    if (!createdTask) {
      const existingRes = await fetch(
        `${supabaseUrl}/rest/v1/tasks?select=*&id=eq.${encodeURIComponent(taskIdForOperation)}&user_id=eq.${encodeURIComponent(userId)}&limit=1`,
        { headers: supabaseHeaders(serviceRoleKey) },
      );
      const existingRows = await existingRes.json().catch(() => []);
      const existing = Array.isArray(existingRows) ? existingRows[0] : null;
      if (
        !existingRes.ok ||
        !existing ||
        existing.type !== 'reminder' ||
        existing.description !== description ||
        new Date(existing.due_at).toISOString() !== new Date(dueMs).toISOString()
      ) {
        return res.status(409).json({ success: false, error: 'Routing operation conflicts with existing data.' });
      }
      createdTask = existing;
    }
    try {
      const messageId = await scheduleMessage(appBaseUrl, createdTask.id, createdTask.due_at, qstashToken, requestId);
      await saveMessageId(supabaseUrl, serviceRoleKey, createdTask.id, messageId, requestId);
      createdTask.qstash_message_id = messageId;
      console.info('[qstash-reminder] routing destination persisted', {
        requestId,
        taskId: createdTask.id,
        destination: 'owner_reminder',
        reasonCode: routing.reasonCode,
        clientBuild: safeBuildForLog(body.routingEvidence),
      });
      return res.status(201).json({ success: true, action: 'created-and-scheduled', task: createdTask, messageId });
    } catch (err) {
      console.error(`[qstash-reminder][${requestId}] routed reminder scheduling failed`, {
        taskId: createdTask.id,
        error: err?.message,
      });
      return res.status(500).json({ success: false, error: 'Reminder saved but exact scheduling failed.' });
    }
  }

  if (action === 'schedule' || action === 'reschedule') {
    const routing = validateOneTimeRoutingEvidence(body.routingEvidence, 'owner_reminder');
    console.info('[qstash-reminder] routing decision', {
      requestId,
      taskId,
      toolInvoked: 'create_reminder',
      destination: body.routingEvidence?.destination ?? 'legacy_owner_reminder',
      reasonCode: routing.reasonCode,
      clientBuild: safeBuildForLog(body.routingEvidence),
    });
    if (!routing.valid) {
      return res.status(409).json({
        success: false,
        error: 'Routing contract rejected reminder scheduling.',
        reasonCode: routing.reasonCode,
      });
    }
  }

  // ── 4. Verify task ownership ────────────────────────────────────────────────
  const taskRes = await fetch(
    `${supabaseUrl}/rest/v1/tasks?select=id,user_id,type,status,qstash_message_id&id=eq.${encodeURIComponent(taskId)}&limit=1`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );
  const tasks = await taskRes.json().catch(() => null);
  const task = Array.isArray(tasks) ? tasks[0] : null;

  if (!task) {
    console.warn(`[qstash-reminder][${requestId}] task not found: ${taskId}`);
    return res.status(404).json({ success: false, error: 'Task not found.' });
  }
  if (task.user_id !== userId) {
    console.warn(`[qstash-reminder][${requestId}] task ownership mismatch`);
    return res.status(403).json({ success: false, error: 'Not your task.' });
  }

  // ── 5. Execute action ───────────────────────────────────────────────────────
  try {
    if (action === 'cancel') {
      await cancelMessage(task.qstash_message_id, qstashToken, requestId);
      await clearMessageId(supabaseUrl, serviceRoleKey, taskId, requestId);
      console.log(`[qstash-reminder][${requestId}] cancelled OK`);
      return res.status(200).json({ success: true, action: 'cancelled' });
    }

    if (action === 'schedule') {
      const messageId = await scheduleMessage(appBaseUrl, taskId, dueAt, qstashToken, requestId);
      await saveMessageId(supabaseUrl, serviceRoleKey, taskId, messageId, requestId);
      console.log(`[qstash-reminder][${requestId}] scheduled OK messageId=${messageId}`);
      return res.status(200).json({ success: true, action: 'scheduled', messageId });
    }

    if (action === 'reschedule') {
      await cancelMessage(task.qstash_message_id, qstashToken, requestId);
      const messageId = await scheduleMessage(appBaseUrl, taskId, dueAt, qstashToken, requestId);
      await saveMessageId(supabaseUrl, serviceRoleKey, taskId, messageId, requestId);
      console.log(`[qstash-reminder][${requestId}] rescheduled OK messageId=${messageId}`);
      return res.status(200).json({ success: true, action: 'rescheduled', messageId });
    }

    if (action === 'schedule-escalation') {
      if (task.type !== 'delegation') {
        console.warn(`[qstash-reminder][${requestId}] schedule-escalation called on non-delegation task type=${task.type}`);
        return res.status(400).json({ success: false, error: 'Only delegation tasks use escalation scheduling.' });
      }
      if (task.status === 'done' || task.status === 'cancelled') {
        console.log(`[qstash-reminder][${requestId}] task already ${task.status} — skipping escalation`);
        return res.status(200).json({ success: true, skipped: true, reason: `task_${task.status}` });
      }
      if (!cronSecret) {
        console.warn(`[qstash-reminder][${requestId}] CRON_SECRET not set — escalation scheduling will fail auth at target`);
      }
      const sentMs = new Date(sentAt).getTime();
      if (Number.isNaN(sentMs)) {
        return res.status(400).json({ success: false, error: `Invalid sentAt: ${sentAt}` });
      }
      const targetUrl       = `${appBaseUrl}/api/process-delegation-escalations`;
      const followupUnix    = Math.floor((sentMs + FOLLOWUP_DELAY_MS)  / 1000);
      const escalationUnix  = Math.floor((sentMs + ESCALATION_DELAY_MS) / 1000);

      const [fuResult, esResult] = await Promise.allSettled([
        publishEscalationMessage({ targetUrl, qstashToken, cronSecret, dedupId: `followup-${taskId}`,   notBefore: followupUnix,   payload: { taskId }, requestId, label: 'followup' }),
        publishEscalationMessage({ targetUrl, qstashToken, cronSecret, dedupId: `escalation-${taskId}`, notBefore: escalationUnix, payload: { taskId }, requestId, label: 'escalation' }),
      ]);

      const fuOk = fuResult.status === 'fulfilled';
      const esOk = esResult.status === 'fulfilled';
      if (!fuOk) console.error(`[qstash-reminder][${requestId}] followup publish failed:`,   fuResult.reason?.message);
      if (!esOk) console.error(`[qstash-reminder][${requestId}] escalation publish failed:`, esResult.reason?.message);

      if (!fuOk && !esOk) {
        return res.status(500).json({ success: false, error: 'Both escalation publishes failed. Cron safety net will cover.' });
      }
      return res.status(200).json({
        success: true,
        followup:   fuOk ? { messageId: fuResult.value, notBefore: followupUnix   } : { error: fuResult.reason?.message },
        escalation: esOk ? { messageId: esResult.value, notBefore: escalationUnix } : { error: esResult.reason?.message },
      });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'QStash operation failed.';
    console.error(`[qstash-reminder][${requestId}] ERROR action=${action} taskId=${taskId}: ${msg}`);
    return res.status(500).json({ success: false, error: msg });
  }
}

async function handleNotificationReceipt(body, res, config) {
  const { taskId, subscriptionId, dueAt, token, stage } = body;
  // Defaults missing kind to 'reminder' — every existing/cached service
  // worker sends no kind field at all, and this keeps their receipts
  // validated exactly as before. 'completion' is the only other kind this
  // endpoint recognizes; anything else falls back to 'reminder' validation
  // (and will simply fail it, same as any other malformed receipt).
  const kind = body.kind === 'completion' ? 'completion' : 'reminder';
  if (!taskId || !subscriptionId || !dueAt || !CLIENT_RECEIPT_STAGES.has(stage)) {
    return res.status(400).json({ success: false, error: 'Invalid notification receipt.' });
  }
  const taskResponse = await fetch(
    `${config.supabaseUrl}/rest/v1/tasks?select=id,user_id,type,due_at,confirmed_at&id=eq.${encodeURIComponent(taskId)}&limit=1`,
    { headers: supabaseHeaders(config.serviceRoleKey) },
  );
  const rows = await taskResponse.json().catch(() => []);
  const task = Array.isArray(rows) ? rows[0] : null;
  // Reminder receipts: exact existing validation, byte-for-byte unchanged.
  // Completion receipts: the same "receipt matches a real, current fact
  // about this exact task" rule, just anchored to confirmed_at (the dueAt
  // slot carries it) instead of due_at — there is no due_at concept for a
  // completion push. Neither branch trusts anything the client claims;
  // both re-derive the comparison value from the database.
  const isValidReminder = kind === 'reminder' && task && task.type === 'reminder' && task.due_at === dueAt;
  const isValidCompletion = kind === 'completion' && task && task.confirmed_at === dueAt;
  if (!isValidReminder && !isValidCompletion) {
    return res.status(404).json({
      success: false,
      error: kind === 'reminder' ? 'Reminder not found.' : 'Completion event not found.',
    });
  }
  const fields = { taskId, userId: task.user_id, subscriptionId, dueAt };
  if (!verifyReminderReceipt(fields, token, config.secret)) {
    return res.status(401).json({ success: false, error: 'Invalid notification receipt token.' });
  }
  const subscriptionResponse = await fetch(
    `${config.supabaseUrl}/rest/v1/push_subscriptions?select=id&` +
      `id=eq.${encodeURIComponent(subscriptionId)}&user_id=eq.${encodeURIComponent(task.user_id)}&limit=1`,
    { headers: supabaseHeaders(config.serviceRoleKey) },
  );
  const subscriptions = await subscriptionResponse.json().catch(() => []);
  if (!Array.isArray(subscriptions) || subscriptions.length !== 1) {
    return res.status(403).json({ success: false, error: 'Subscription does not belong to reminder owner.' });
  }
  const eventAt = new Date().toISOString();
  const eventKey = `${stage}:${subscriptionId}`;
  await recordDeliveryEvent({
    supabaseUrl: config.supabaseUrl,
    serviceRoleKey: config.serviceRoleKey,
    taskId,
    userId: task.user_id,
    subscriptionId,
    eventKey,
    stage,
    metadata: {
      kind,
      swVersion: typeof body.swVersion === 'string' ? body.swVersion.slice(0, 80) : null,
      detail: typeof body.detail === 'string' ? body.detail.slice(0, 80) : null,
    },
  });
  // Reminder-specific interaction semantics: tapping a due reminder's
  // notification means "I'm done." A completion push's notification_click
  // has no such meaning (the task is already done — this PATCH's own
  // status=eq.pending filter would no-op for it regardless, but scoping to
  // kind === 'reminder' keeps reminder-only business logic from silently
  // reapplying to a different event kind if this block ever changes).
  if (stage === 'notification_clicked' && kind === 'reminder') {
    await fetch(`${config.supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}&status=eq.pending`, {
      method: 'PATCH',
      headers: { ...supabaseHeaders(config.serviceRoleKey), Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'done',
        confirmed_at: eventAt,
        confirmed_by: 'notification_click',
        reminder_delivery_status: 'interacted',
        reminder_interacted_at: eventAt,
      }),
    });
  }
  return res.status(200).json({ success: true });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Normalises APP_BASE_URL the same way for every caller in this file — a
 * scheme is required (QStash rejects destinations without https://) and no
 * trailing slash, so URL concatenation elsewhere never produces "//api". */
export function resolveAppBaseUrl() {
  let appBaseUrl = (process.env.APP_BASE_URL || 'https://ra7etbal.com').trim();
  if (appBaseUrl && !appBaseUrl.startsWith('http://') && !appBaseUrl.startsWith('https://')) {
    appBaseUrl = `https://${appBaseUrl}`;
  }
  return appBaseUrl.replace(/\/$/, '');
}

/**
 * Publishes a one-shot QStash wake-up for the exact moment a recurring
 * automation's next cycle becomes due. Targets the SAME endpoint the
 * existing 10-minute cron already calls, with the same
 * `{ action: 'run-automations' }` dispatch — so runAutomationsCore always
 * re-derives which automation(s) are actually due fresh from the database
 * regardless of what triggered this invocation (automationId/nextRunAt
 * below are for logging only, never trusted for selection — see
 * process-delegation-escalations.js's own "scheduled triggers are wake-up
 * signals only" safety note).
 *
 * Deterministic dedup ID (automation-run-{automationId}-{nextRunAt}) means a
 * duplicate publish for the same cycle is a safe no-op at the QStash layer,
 * on top of the existing automation_runs unique-constraint idempotency
 * inside runAutomationsCore itself.
 *
 * Throws on any failure (missing QSTASH_TOKEN, invalid nextRunAt, QStash
 * rejecting the publish). Callers — api/automations.js after creation, and
 * advanceNextRunAt in process-delegation-escalations.js after a successful
 * advance — must treat a thrown error here as "exact scheduling failed,
 * cron fallback active," never as a reason to fail or roll back the
 * already-persisted automation row.
 */
export async function scheduleAutomationRunWakeup({ appBaseUrl, automationId, nextRunAt, requestId = 'srv' }) {
  const qstashToken = process.env.QSTASH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;
  if (!qstashToken) {
    throw new Error('QSTASH_TOKEN not configured.');
  }
  if (!cronSecret) {
    // Matches the existing schedule-escalation warning below — without this,
    // the publish itself still succeeds (QStash returns 200/202 for a valid
    // publish regardless of the forwarded auth header's contents), but the
    // wake-up would fail auth at /api/process-delegation-escalations when it
    // actually fires, with the failure invisible to this caller.
    console.warn(`[qstash-reminder][${requestId}] CRON_SECRET not set — automation-run wake-up will fail auth at target`);
  }
  const notBeforeMs = new Date(nextRunAt).getTime();
  if (Number.isNaN(notBeforeMs)) {
    throw new Error(`Invalid nextRunAt: ${nextRunAt}`);
  }
  // This call forwards CRON_SECRET via Upstash-Forward-Authorization to
  // appBaseUrl — a caller-supplied value (process-delegation-escalations.js
  // passes raw process.env.APP_BASE_URL). A misconfigured http:// deployment
  // would send that secret in plaintext. Enforced here specifically, rather
  // than in the shared resolveAppBaseUrl() above, so the three pre-existing
  // actions on the default HTTP handler (schedule/cancel/reschedule, none of
  // which forward CRON_SECRET) keep their exact current behavior unchanged.
  if (!appBaseUrl?.startsWith('https://')) {
    throw new Error(`appBaseUrl must use https:// — refusing to forward CRON_SECRET over an insecure scheme: ${appBaseUrl}`);
  }

  return publishEscalationMessage({
    targetUrl: `${appBaseUrl}/api/process-delegation-escalations`,
    qstashToken,
    cronSecret,
    // Confirmed production bug: QStash rejects a Deduplication-Id containing
    // ':' — the raw ISO nextRunAt (e.g. "2026-07-13T12:15:00.000Z") has
    // several, so every publish failed and silently fell back to the
    // 10-minute cron poll, defeating exact-time scheduling entirely. Use the
    // already-computed epoch-ms value instead: digits only, and still
    // deterministic for the same (automationId, nextRunAt) pair, so the
    // dedup guarantee documented above is unchanged.
    dedupId: `automation-run-${automationId}-${notBeforeMs}`,
    // Round UP, never down: a fractional-second nextRunAt (e.g. "...:00.500Z")
    // floored to "...:00" would make QStash invoke the wake-up up to 999ms
    // before the automation is actually due. runAutomationsCore's own query
    // (next_run_at<=now()) would then correctly find nothing yet due, so the
    // wake-up would silently no-op — the exact cycle it was meant to catch
    // falls through to the 10-minute cron fallback instead. Firing up to
    // ~1s late is fine (the whole point is "as close as technically
    // possible," not a guaranteed exact second); firing early defeats it.
    notBefore: Math.ceil(notBeforeMs / 1000),
    payload: { action: 'run-automations' },
    requestId,
    label: 'automation-run',
  });
}

async function scheduleMessage(appBaseUrl, taskId, dueAt, qstashToken, requestId) {
  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(dueMs)) throw new Error(`Invalid dueAt value: ${dueAt}`);

  const notBeforeUnix = Math.floor(dueMs / 1000);

  const callbackUrl = `${appBaseUrl}/api/send-push-for-task`;

  // QStash publish endpoint expects the destination URL as a raw absolute URL in the path.
  // Do not encode it. Encoding turns "https://..." into "https%3A%2F%2F..." and QStash rejects it as missing a scheme.
  const response = await fetch(`${QSTASH_BASE}/publish/${callbackUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${qstashToken}`,
      'Content-Type': 'application/json',
      'Upstash-Not-Before': String(notBeforeUnix),
      'Upstash-Deduplication-Id': `reminder-${taskId}`,
      'Upstash-Retries': '3',
    },
    body: JSON.stringify({ taskId }),
  });

  const data = await response.json().catch(() => null);
  console.log(`[qstash-reminder][DIAG][${requestId}] action=schedule callbackUrl=${callbackUrl} notBefore=${notBeforeUnix} QStash_status=${response.status} QStash_body=${JSON.stringify(data)}`);

  if (!response.ok) {
    throw new Error(data?.error || `QStash schedule failed (${response.status})`);
  }

  if (!data?.messageId && !data?.message_id) {
    throw new Error(`QStash schedule succeeded but returned no message ID: ${JSON.stringify(data)}`);
  }

  return data.messageId ?? data.message_id;
}

async function cancelMessage(qstashMessageId, qstashToken, requestId) {
  if (!qstashMessageId) {
    console.log(`[qstash-reminder][${requestId}] cancel: no messageId stored, skipping`);
    return;
  }

  console.log(`[qstash-reminder][${requestId}] cancelling QStash messageId=${qstashMessageId}`);
  const response = await fetch(`${QSTASH_BASE}/messages/${qstashMessageId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${qstashToken}` },
  });

  if (!response.ok && response.status !== 404) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `QStash cancel failed (${response.status})`);
  }
  console.log(`[qstash-reminder][${requestId}] cancel response: ${response.status}`);
}

async function saveMessageId(supabaseUrl, serviceRoleKey, taskId, messageId, requestId) {
  console.log(`[qstash-reminder][${requestId}] saving messageId=${messageId} to task ${taskId}`);
  const response = await fetch(
    `${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(serviceRoleKey), Prefer: 'return=minimal' },
      body: JSON.stringify({
        qstash_message_id: messageId,
        ...(messageId ? { reminder_delivery_status: 'scheduled', reminder_delivery_error: null } : {}),
      }),
    },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    console.error(`[qstash-reminder][${requestId}] Supabase PATCH failed: ${response.status} ${JSON.stringify(data)}`);
    throw new Error(data?.message || 'Could not save QStash message ID.');
  }
  console.log(`[qstash-reminder][${requestId}] Supabase PATCH OK: ${response.status}`);
}

async function clearMessageId(supabaseUrl, serviceRoleKey, taskId, requestId) {
  await saveMessageId(supabaseUrl, serviceRoleKey, taskId, null, requestId);
}

async function publishEscalationMessage({ targetUrl, qstashToken, cronSecret, dedupId, notBefore, payload, requestId, label }) {
  const response = await fetch(`${QSTASH_BASE}/publish/${targetUrl}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${qstashToken}`,
      'Content-Type': 'application/json',
      'Upstash-Not-Before': String(notBefore),
      'Upstash-Deduplication-Id': dedupId,
      'Upstash-Retries': '3',
      'Upstash-Forward-Authorization': `Bearer ${cronSecret}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null);
  console.log(`[qstash-reminder][DIAG][${requestId}] action=schedule-escalation label=${label} targetUrl=${targetUrl} notBefore=${notBefore} QStash_status=${response.status} QStash_body=${JSON.stringify(data)}`);

  if (!response.ok) {
    throw new Error(data?.error || `QStash publish failed (${response.status})`);
  }
  if (!data?.messageId && !data?.message_id) {
    throw new Error(`QStash publish succeeded but returned no messageId: ${JSON.stringify(data)}`);
  }
  return data.messageId ?? data.message_id;
}

function supabaseHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}
