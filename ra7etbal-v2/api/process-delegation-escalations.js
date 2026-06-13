/**
 * POST /api/process-delegation-escalations
 * GET  /api/process-delegation-escalations
 *
 * NOTE: Scheduling is handled by QStash (not Vercel cron) because
 * Vercel Hobby cron does not support frequent schedules (every 10 minutes).
 *
 * To register the QStash schedule (run once after each new production deployment):
 *
 *   curl -X POST \
 *     "https://qstash.upstash.io/v2/schedules/https%3A%2F%2Fra7etbal-v2.vercel.app%2Fapi%2Fprocess-delegation-escalations" \
 *     -H "Authorization: Bearer <QSTASH_TOKEN>" \
 *     -H "Upstash-Cron: every 10 minutes" \
 *     -H "Upstash-Forward-Authorization: Bearer <CRON_SECRET>" \
 *     -H "Upstash-Method: POST"
 *
 * QStash forwards Authorization: Bearer <CRON_SECRET> on every scheduled call
 * so the existing CRON_SECRET auth below works unchanged.
 *
 * To verify the schedule exists:
 *
 *   curl -s https://qstash.upstash.io/v2/schedules \
 *     -H "Authorization: Bearer $QSTASH_TOKEN" \
 *     | grep process-delegation-escalations
 *
 * If no schedule is returned, register it:
 *
 *   curl -X POST \
 *     "https://qstash.upstash.io/v2/schedules/https%3A%2F%2Fra7etbal-v2.vercel.app%2Fapi%2Fprocess-delegation-escalations" \
 *     -H "Authorization: Bearer $QSTASH_TOKEN" \
 *     -H "Upstash-Cron: every 10 minutes" \
 *     -H "Upstash-Forward-Authorization: Bearer $CRON_SECRET" \
 *     -H "Upstash-Method: POST"
 *
 * Polls for unconfirmed delegated tasks and fires two timed escalations:
 *
 *   10 min  → WhatsApp follow-up to the assigned person (one send max)
 *   20 min  → Web-push notification to the owner       (one send max)
 *
 * Guards: followup_sent_at / escalated_at columns on tasks table.
 * Once either column is stamped the action is never repeated, even if
 * the cron fires again.
 *
 * ── testMode ──────────────────────────────────────────────────────────────
 * Append ?testMode=true when calling manually to collapse the thresholds:
 *   follow-up threshold  : 1 minute  (production: 10 min)
 *   escalation threshold : 2 minutes (production: 20 min)
 *
 * testMode is detected from the query string only — the Vercel cron never
 * appends query params, so production is unaffected.
 * testMode does NOT change stored data or schema.
 */

import webpush from 'web-push';
import { Receiver } from '@upstash/qstash';

const MAX_TASKS_PER_RUN = 50;

// ── Production thresholds ────────────────────────────────────────────────────
const PROD_FOLLOWUP_MS  = 10 * 60 * 1000; //  10 minutes
const PROD_ESCALATE_MS  = 20 * 60 * 1000; //  20 minutes

// ── testMode thresholds ──────────────────────────────────────────────────────
const TEST_FOLLOWUP_MS  = 1 * 60 * 1000;  //   1 minute
const TEST_ESCALATE_MS  = 2 * 60 * 1000;  //   2 minutes

export default async function handler(req, res) {
  const runStartedAt = new Date();
  console.log('[escalation] job started', {
    method: req.method,
    url: req.url,
    startedAt: runStartedAt.toISOString(),
    userAgent: req.headers['user-agent'] || null,
    hasAuthorizationHeader: Boolean(req.headers.authorization || req.headers.Authorization),
  });

  if (req.method !== 'GET' && req.method !== 'POST') {
    console.log('[escalation] job rejected: method not allowed', { method: req.method });
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  // testMode bypasses the CRON_SECRET check so developers can call the
  // endpoint directly from a browser or curl without needing the secret.
  const testMode = isTestMode(req);

  if (!testMode && !(await isAuthorized(req))) {
    console.log('[escalation] job rejected: unauthorized', {
      hasCronSecret: Boolean(process.env.CRON_SECRET),
      hasAuthorizationHeader: Boolean(req.headers.authorization || req.headers.Authorization),
      hasQStashSignature: Boolean(req.headers['upstash-signature']),
      hasQStashSigningKeys: Boolean(
        process.env.QSTASH_CURRENT_SIGNING_KEY && process.env.QSTASH_NEXT_SIGNING_KEY,
      ),
    });
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (testMode) {
    console.log('[escalation] ⚠️  testMode ACTIVE — thresholds: followup=1min escalate=2min');
  }

  // ── Config ─────────────────────────────────────────────────────────────────
  const supabaseUrl    = process.env.SUPABASE_URL;
  const serviceKey     = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const vapidPublic    = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
  const vapidPrivate   = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject   = process.env.VAPID_SUBJECT;
  const appBaseUrl     = (process.env.APP_BASE_URL || 'https://ra7etbal-v2.vercel.app').trim();

  const missing = [];
  if (!supabaseUrl)  missing.push('SUPABASE_URL');
  if (!serviceKey)   missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!vapidPublic)  missing.push('VAPID_PUBLIC_KEY');
  if (!vapidPrivate) missing.push('VAPID_PRIVATE_KEY');
  if (!vapidSubject) missing.push('VAPID_SUBJECT');

  if (missing.length > 0) {
    console.error('[escalation] missing env vars:', missing.join(', '));
    return res.status(500).json({ error: `Missing config: ${missing.join(', ')}` });
  }

  console.log('[escalation] config ok', {
    hasSupabaseUrl: Boolean(supabaseUrl),
    hasServiceRoleKey: Boolean(serviceKey),
    hasVapidPublic: Boolean(vapidPublic),
    hasVapidPrivate: Boolean(vapidPrivate),
    hasVapidSubject: Boolean(vapidSubject),
    appBaseUrl,
    testMode,
  });

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  // ── Action dispatch ────────────────────────────────────────────────────────
  const requestBody = (typeof req.body === 'object' && req.body !== null) ? req.body : {};
  if (requestBody.action === 'run-routines') {
    return runRoutines(req, res, { supabaseUrl, serviceKey, appBaseUrl });
  }
  if (requestBody.action === 'setup-routines-schedule') {
    return setupRoutinesSchedule(res, { appBaseUrl });
  }

  const now = new Date();
  const followupThresholdMs = testMode ? TEST_FOLLOWUP_MS : PROD_FOLLOWUP_MS;
  const escalateThresholdMs = testMode ? TEST_ESCALATE_MS : PROD_ESCALATE_MS;

  // Fetch pending tasks old enough to potentially need at least the follow-up.
  //
  // Important: do NOT filter by type at the PostgREST level. Real delegated
  // rows can be recognized by the operational signals used elsewhere in the
  // app: assigned_to + needs_follow_up. Keeping the query wider lets this job
  // log exactly why a row was skipped instead of silently missing it.
  const oldestRelevantCutoff = new Date(now.getTime() - followupThresholdMs).toISOString();

  const headers = supabaseHeaders(serviceKey);

  // ── Fetch candidate tasks ──────────────────────────────────────────────────
  const tasksUrl =
    `${supabaseUrl}/rest/v1/tasks` +
    `?select=id,user_id,description,type,assigned_to,status,needs_follow_up,confirmation_url,` +
    `created_at,followup_sent_at,escalated_at` +
    `&status=eq.pending` +
    `&archived_at=is.null` +
    `&created_at=lte.${encodeURIComponent(oldestRelevantCutoff)}` +
    `&order=created_at.asc` +
    `&limit=${MAX_TASKS_PER_RUN}`;

  const tasksRes = await fetch(tasksUrl, { headers });
  const tasks = await tasksRes.json().catch(() => []);

  if (!tasksRes.ok) {
    console.error('[escalation] failed to fetch tasks:', {
      status: tasksRes.status,
      message: tasks?.message,
      details: tasks?.details,
      hint: tasks?.hint,
    });
    return res.status(500).json({ error: 'Could not fetch tasks.' });
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.log('[escalation] eligible tasks found=0', {
      cutoff: oldestRelevantCutoff,
      followupThresholdMs,
      escalateThresholdMs,
    });
    console.log('[escalation] job completed', {
      checked: 0,
      followupsSent: 0,
      escalationsSent: 0,
      durationMs: Date.now() - runStartedAt.getTime(),
    });
    return res.status(200).json({ checked: 0, followupsSent: 0, escalationsSent: 0 });
  }

  console.log('[escalation] eligible tasks found', {
    candidates: tasks.length,
    cutoff: oldestRelevantCutoff,
    followupThresholdMs,
    escalateThresholdMs,
    testMode,
  });

  const stats = { checked: tasks.length, followupsSent: 0, escalationsSent: 0, errors: [] };

  for (const task of tasks) {
    const ageMs = now.getTime() - new Date(task.created_at).getTime();
    const skipReason = getDelegationSkipReason(task);
    if (skipReason) {
      console.log('[escalation] task skipped with reason', {
        taskId: task.id,
        reason: skipReason,
        type: task.type,
        assignedTo: task.assigned_to || null,
        needsFollowUp: task.needs_follow_up === true,
        status: task.status,
        ageMs,
        followupSentAt: task.followup_sent_at || null,
        escalatedAt: task.escalated_at || null,
      });
      continue;
    }

    console.log('[escalation] task eligible', {
      taskId: task.id,
      type: task.type,
      assignedTo: task.assigned_to,
      ageMs,
      followupGuardAlreadySet: Boolean(task.followup_sent_at),
      escalationGuardAlreadySet: Boolean(task.escalated_at),
    });

    // ── Follow-up (10 min / 1 min in testMode) ────────────────────────────
    const followupDue = ageMs >= followupThresholdMs && !task.followup_sent_at;
    if (followupDue) {
      console.log('[escalation] follow-up attempted', { taskId: task.id, assignedTo: task.assigned_to });
      const sent = await sendFollowupWhatsApp({
        task,
        supabaseUrl,
        serviceKey,
        appBaseUrl,
        testMode,
      });
      if (sent) {
        stats.followupsSent += 1;
        // Stamp guard column immediately to prevent re-send.
        await stampColumn(supabaseUrl, serviceKey, task.id, 'followup_sent_at', now.toISOString());
      } else {
        stats.errors.push(`followup failed for task ${task.id}`);
      }
    } else {
      console.log('[escalation] task skipped with reason', {
        taskId: task.id,
        reason: task.followup_sent_at ? 'follow-up guard already set' : 'follow-up threshold not reached',
        ageMs,
        thresholdMs: followupThresholdMs,
        followupSentAt: task.followup_sent_at || null,
      });
    }

    // ── Escalation (20 min / 2 min in testMode) ───────────────────────────
    const escalateDue = ageMs >= escalateThresholdMs && !task.escalated_at;
    if (escalateDue) {
      console.log('[escalation] escalation attempted', { taskId: task.id, assignedTo: task.assigned_to });
      const sent = await sendOwnerEscalationPush({
        task,
        supabaseUrl,
        serviceKey,
        testMode,
      });
      if (sent) {
        stats.escalationsSent += 1;
      } else {
        stats.errors.push(`escalation push failed for task ${task.id}`);
        console.warn('[escalation] push failed — stamping escalated_at to prevent indefinite retry', { taskId: task.id });
      }
      // Stamp regardless of push outcome. Escalation is a one-shot event at the
      // 20-min mark. Leaving escalated_at null on failure causes every subsequent
      // cron run to retry, producing unpredictable delayed notifications.
      await stampColumn(supabaseUrl, serviceKey, task.id, 'escalated_at', now.toISOString());
    } else {
      console.log('[escalation] task skipped with reason', {
        taskId: task.id,
        reason: task.escalated_at ? 'escalation guard already set' : 'escalation threshold not reached',
        ageMs,
        thresholdMs: escalateThresholdMs,
        escalatedAt: task.escalated_at || null,
      });
    }
  }

  console.log('[escalation] job completed', {
    ...stats,
    durationMs: Date.now() - runStartedAt.getTime(),
  });
  return res.status(200).json(stats);
}

// ── Follow-up: re-send the original WhatsApp template ─────────────────────────

async function sendFollowupWhatsApp({ task, supabaseUrl, serviceKey, appBaseUrl, testMode }) {
  const { id: taskId, user_id, assigned_to, description, confirmation_url } = task;

  if (!assigned_to) {
    console.log(`[escalation] task ${taskId}: no assigned_to, skipping follow-up`);
    return false;
  }
  if (!confirmation_url) {
    console.log(`[escalation] task ${taskId}: no confirmation_url, skipping follow-up`);
    return false;
  }

  // Resolve phone from people table (match by name + user_id).
  const personPhone = await resolvePhone(supabaseUrl, serviceKey, user_id, assigned_to);
  if (!personPhone) {
    console.warn(`[escalation] task ${taskId}: could not resolve phone for "${assigned_to}", skipping follow-up`);
    return false;
  }

  // Resolve owner display name for two purposes:
  //   1. Rewrite pronouns in the description ("you" → owner's name) for the recipient.
  //   2. Pass as ownerName to send-whatsapp-task so the task template {{1}} shows
  //      the real owner name instead of the "Rahet Bal" server fallback.
  const ownerName = await resolveOwnerName(supabaseUrl, serviceKey, user_id);
  const rewrittenDescription = rewriteDelegationPronouns(description, ownerName);
  const messageText = `Following up: ${rewrittenDescription}`;
  const label = testMode ? '[testMode] ' : '';
  console.log(`[escalation] ${label}sending follow-up WhatsApp to ${assigned_to} for task ${taskId}`, {
    route: `${appBaseUrl}/api/send-whatsapp-task`,
    hasPhone: Boolean(personPhone),
    hasConfirmationUrl: Boolean(confirmation_url),
    ownerName,
  });

  try {
    const res = await fetch(`${appBaseUrl}/api/send-whatsapp-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: personPhone,
        messageText,
        confirmationLink: confirmation_url,
        taskId,
        recipientName: assigned_to,
        ownerName,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[escalation] follow-up WhatsApp failed for task ${taskId}:`, {
        status: res.status,
        error: data?.error,
        details: data?.details,
        errorMessage: data?.errorMessage,
      });
      return false;
    }
    console.log(`[escalation] follow-up sent`, {
      taskId,
      assignedTo: assigned_to,
      ownerName,
      sendMode: data?.sendMode || data?.sendType || null,
      templateName: data?.templateName || null,
      messageId: data?.messageId || null,
    });
    return true;
  } catch (err) {
    console.error(`[escalation] follow-up WhatsApp threw for task ${taskId}:`, err?.message);
    return false;
  }
}

// ── Escalation: owner web-push ─────────────────────────────────────────────────

async function sendOwnerEscalationPush({ task, supabaseUrl, serviceKey, testMode }) {
  const { id: taskId, user_id, assigned_to, description } = task;

  // Fetch owner's enabled push subscriptions.
  const subsRes = await fetch(
    `${supabaseUrl}/rest/v1/push_subscriptions` +
      `?user_id=eq.${encodeURIComponent(user_id)}` +
      `&enabled=eq.true` +
      `&select=id,endpoint,p256dh,auth`,
    { headers: supabaseHeaders(serviceKey) },
  );
  const subscriptions = await subsRes.json().catch(() => []);

  if (!subsRes.ok) {
    console.error(`[escalation] task ${taskId}: failed to load owner push subscriptions`, {
      status: subsRes.status,
      message: subscriptions?.message,
      details: subscriptions?.details,
    });
    return false;
  }

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    console.log(`[escalation] task ${taskId}: owner has no push subscriptions, skipping escalation`);
    return false;
  }

  const who = assigned_to ? `${assigned_to} hasn't confirmed` : 'Unconfirmed task';
  const timeLabel = testMode ? '(test)' : '20 minutes ago';
  const body = `${who}: ${description}. Sent ${timeLabel}.`;
  const payload = JSON.stringify({ title: 'Ra7etBal · Action needed', body });

  const label = testMode ? '[testMode] ' : '';
  console.log(`[escalation] ${label}sending owner escalation push for task ${taskId}`, {
    subscriptionCount: subscriptions.length,
  });

  let sent = false;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { urgency: 'high', TTL: 300 },
      );
      console.log(`[escalation] escalation push sent`, { subId: sub.id, taskId });
      sent = true;
    } catch (err) {
      const status = err?.statusCode ?? null;
      console.error(`[escalation] push failed sub=${sub.id} status=${status}:`, err?.message);
      // Clean up permanently invalid subscriptions.
      if (status === 410 || status === 404) {
        await fetch(
          `${supabaseUrl}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(sub.id)}`,
          { method: 'DELETE', headers: supabaseHeaders(serviceKey) },
        ).catch(() => {});
      }
    }
  }
  return sent;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolvePhone(supabaseUrl, serviceKey, userId, assignedTo) {
  const target = normalizeName(assignedTo);
  const res = await fetch(
    `${supabaseUrl}/rest/v1/people` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&select=name,phone`,
    { headers: supabaseHeaders(serviceKey) },
  );
  const rows = await res.json().catch(() => []);
  if (!res.ok) {
    console.error('[escalation] people lookup failed', {
      userId,
      assignedTo,
      status: res.status,
      message: rows?.message,
      details: rows?.details,
    });
    return null;
  }
  if (!Array.isArray(rows)) return null;

  const exact = rows.find((row) => normalizeName(row.name) === target);
  if (exact?.phone) return exact.phone;

  const loose = rows.find((row) => {
    const name = normalizeName(row.name);
    return name && (name.includes(target) || target.includes(name));
  });
  return loose?.phone || null;
}

async function resolveOwnerName(supabaseUrl, serviceKey, userId) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/profiles` +
      `?id=eq.${encodeURIComponent(userId)}` +
      `&select=display_name` +
      `&limit=1`,
    { headers: supabaseHeaders(serviceKey) },
  );
  const rows = await res.json().catch(() => []);
  const name = Array.isArray(rows) && rows.length > 0 ? rows[0].display_name : null;
  return typeof name === 'string' && name.trim() ? name.trim() : 'the sender';
}

/**
 * Rewrite owner-facing pronouns so the recipient reads the correct name.
 * Used on task.description (stored from the owner's perspective).
 *
 * Safe to include "you" here because description is always owner-facing:
 *   "text you in one minute" → "text Sana in one minute"
 * Unlike suggestedMessage, description does NOT use "you" to address Grace.
 */
function rewriteDelegationPronouns(text, ownerName) {
  const name = (typeof ownerName === 'string' && ownerName.trim()) ? ownerName.trim() : 'the sender';
  return text
    .replace(/\byou\b/gi, name)
    .replace(/\byour\b/gi, `${name}'s`)
    .replace(/\byourself\b/gi, name)
    .replace(/\bmy\b/gi, `${name}'s`)
    .replace(/\bmyself\b/gi, name)
    .replace(/\bme\b/gi, name)
    .replace(/\bI\b/g, name);
}

async function stampColumn(supabaseUrl, serviceKey, taskId, column, value) {
  // Guard: only stamp if still null (prevents race conditions on concurrent runs).
  const res = await fetch(
    `${supabaseUrl}/rest/v1/tasks` +
      `?id=eq.${encodeURIComponent(taskId)}` +
      `&${column}=is.null`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ [column]: value }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[escalation] stampColumn ${column} failed for task ${taskId}: ${res.status} ${body}`);
  } else {
    console.log('[escalation] guard stamped', { taskId, column, value });
  }
}

function getDelegationSkipReason(task) {
  if (!task) return 'missing task';
  if (task.status !== 'pending') return `status is ${task.status}`;
  if (!task.assigned_to || !String(task.assigned_to).trim()) return 'no assigned person';

  const isDelegatedType = task.type === 'delegation' || task.type === 'followup';
  const isWaitingForAssignee = task.needs_follow_up === true || isDelegatedType;
  if (!isWaitingForAssignee) {
    return 'not a delegated/follow-up task';
  }

  return null;
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function supabaseHeaders(serviceKey) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

function isTestMode(req) {
  if (req.query?.testMode === 'true') return true;
  try {
    const url = new URL(req.url, 'https://ra7etbal.local');
    return url.searchParams.get('testMode') === 'true';
  } catch {
    return false;
  }
}

// ── QStash schedule setup ─────────────────────────────────────────────────────

/**
 * Self-registers an hourly QStash cron schedule that POSTs
 * { action: "run-routines" } to this same endpoint.
 * Called once via: POST /api/process-delegation-escalations?testMode=true
 *                  body: { "action": "setup-routines-schedule" }
 *
 * Idempotent — QStash deduplicates by schedule ID. Re-running overwrites
 * the existing schedule with the same settings (safe to call again).
 */
async function setupRoutinesSchedule(res, { appBaseUrl }) {
  const qstashToken = process.env.QSTASH_TOKEN;
  const cronSecret  = process.env.CRON_SECRET;

  if (!qstashToken) {
    console.error('[routines-setup] QSTASH_TOKEN not set');
    return res.status(500).json({ error: 'QSTASH_TOKEN not configured' });
  }
  if (!cronSecret) {
    console.error('[routines-setup] CRON_SECRET not set');
    return res.status(500).json({ error: 'CRON_SECRET not configured' });
  }

  // Use Upstash-Destination header instead of path-based URL.
  // The path approach with encodeURIComponent can be mangled by the Node runtime.
  const targetUrl = 'https://ra7etbal-v2.vercel.app/api/process-delegation-escalations';

  console.log('[routines-setup] registering QStash schedule', { targetUrl });

  try {
    const schedRes = await fetch(
      'https://qstash.upstash.io/v2/schedules',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${qstashToken}`,
          'Upstash-Destination': targetUrl,
          'Upstash-Cron': '0 * * * *',          // top of every hour
          'Upstash-Forward-Authorization': `Bearer ${cronSecret}`,
          'Upstash-Method': 'POST',
          'Upstash-Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'run-routines' }),
      },
    );

    const data = await schedRes.json().catch(() => ({}));

    if (!schedRes.ok) {
      console.error('[routines-setup] QStash registration failed', {
        status: schedRes.status,
        error: data?.error,
      });
      return res.status(500).json({ error: 'QStash registration failed', details: data });
    }

    console.log('[routines-setup] QStash schedule registered', {
      scheduleId: data?.scheduleId || data?.schedule_id || null,
      cron: '0 * * * *',
      targetUrl,
    });
    return res.status(200).json({
      ok: true,
      scheduleId: data?.scheduleId || data?.schedule_id || null,
      cron: '0 * * * *',
      targetUrl,
    });
  } catch (err) {
    console.error('[routines-setup] fetch threw:', err?.message);
    return res.status(500).json({ error: err?.message });
  }
}

// ── Routines runner ───────────────────────────────────────────────────────────

/**
 * Handle { action: "run-routines" } dispatched from the main handler.
 * Queries all enabled routines, checks which are due, and executes them.
 * Each routine is wrapped in try/catch — one failure never stops the batch.
 */
async function runRoutines(_req, res, { supabaseUrl, serviceKey, appBaseUrl }) {
  const startedAt = new Date();
  console.log('[routines] job started', { startedAt: startedAt.toISOString() });

  const now = new Date();
  const stats = { checked: 0, executed: 0, skipped: 0, failed: 0 };

  // 1. Fetch all enabled routines.
  const routinesRes = await fetch(
    `${supabaseUrl}/rest/v1/routines` +
      `?enabled=eq.true` +
      `&select=id,user_id,name,type,schedule,schedule_day,schedule_time,timezone,payload,last_run_at`,
    { headers: supabaseHeaders(serviceKey) },
  );
  const routines = await routinesRes.json().catch(() => []);

  if (!routinesRes.ok) {
    console.error('[routines] failed to fetch routines:', routines?.message);
    return res.status(500).json({ error: 'Could not fetch routines.' });
  }

  if (!Array.isArray(routines) || routines.length === 0) {
    console.log('[routines] no enabled routines');
    return res.status(200).json(stats);
  }

  stats.checked = routines.length;
  console.log('[routines] enabled routines found', { count: routines.length });

  // 2. Process each routine independently.
  for (const routine of routines) {
    try {
      if (!isRoutineDue(routine, now)) {
        console.log('[routines] skipped (not due)', { routineId: routine.id, name: routine.name });
        stats.skipped++;
        continue;
      }

      console.log('[routines] executing', {
        routineId: routine.id,
        name: routine.name,
        type: routine.type,
        schedule: routine.schedule,
      });

      let executed = false;

      if (routine.type === 'reminder') {
        executed = await executeReminderRoutine({ routine, supabaseUrl, serviceKey });

      } else if (routine.type === 'delegation') {
        const result = await executeDelegationRoutine({ routine, supabaseUrl, serviceKey, appBaseUrl });
        if (result === 'missing_person') {
          // Person is gone — disable routine so it stops firing.
          await disableRoutine(supabaseUrl, serviceKey, routine.id);
          console.warn('[routines] routine disabled (missing person)', { routineId: routine.id });
          stats.skipped++;
          continue;
        }
        executed = result === true;
      }

      if (executed) {
        await stampRoutineLastRun(supabaseUrl, serviceKey, routine.id, now.toISOString());
        stats.executed++;
        console.log('[routines] executed ok', { routineId: routine.id });
      } else {
        stats.failed++;
        console.warn('[routines] execution returned false', { routineId: routine.id });
      }

    } catch (err) {
      console.error('[routines] uncaught error for routine', {
        routineId: routine.id,
        error: err?.message,
      });
      stats.failed++;
    }
  }

  console.log('[routines] job completed', {
    ...stats,
    durationMs: Date.now() - startedAt.getTime(),
  });
  return res.status(200).json(stats);
}

/**
 * Determine if a routine should fire on this cron tick.
 *
 * A routine is due when ALL of these hold in its local timezone:
 *   1. It is the correct day-of-week (weekly only).
 *   2. The scheduled clock time has passed (nowMinutes >= schedMinutes).
 *   3. No more than 59 minutes have elapsed past the schedule time, so a
 *      missed tick from a previous hour is not re-fired.
 *   4. It has not already run during today's schedule window (last_run_at is
 *      before today's schedule_time in the same local timezone).
 */
function isRoutineDue(routine, now) {
  const tz = routine.timezone || 'UTC';
  try {
    const local = getLocalParts(now, tz);
    const [schedHour, schedMinute] = routine.schedule_time.split(':').map(Number);

    // Weekly: must be the correct weekday.
    if (routine.schedule === 'weekly' && routine.schedule_day !== local.dayOfWeek) return false;

    const nowMinutes  = local.hour * 60 + local.minute;
    const schedMinutes = schedHour  * 60 + schedMinute;

    if (nowMinutes < schedMinutes)       return false; // not yet today
    if (nowMinutes - schedMinutes > 59)  return false; // past the 1-hour window

    // Already ran during today's window?
    if (routine.last_run_at) {
      const lastLocal = getLocalParts(new Date(routine.last_run_at), tz);
      const sameDay   =
        lastLocal.year  === local.year  &&
        lastLocal.month === local.month &&
        lastLocal.day   === local.day;
      const lastMinutes = lastLocal.hour * 60 + lastLocal.minute;
      if (sameDay && lastMinutes >= schedMinutes) return false;
    }

    return true;
  } catch (err) {
    console.warn('[routines] isRoutineDue error', { routineId: routine.id, error: err?.message });
    return false;
  }
}

/**
 * Decompose a Date into local calendar/clock parts for a given IANA timezone.
 * Uses Intl.DateTimeFormat — reliable in Node.js 18+.
 */
function getLocalParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year:    'numeric',
    month:   '2-digit',
    day:     '2-digit',
    hour:    '2-digit',
    minute:  '2-digit',
    hour12:  false,
    weekday: 'short',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    year:      parseInt(parts.year,   10),
    month:     parseInt(parts.month,  10),
    day:       parseInt(parts.day,    10),
    // "24" can appear for midnight in some V8 builds — normalise with % 24.
    hour:      parseInt(parts.hour,   10) % 24,
    minute:    parseInt(parts.minute, 10),
    dayOfWeek: WEEKDAYS.indexOf(parts.weekday),
  };
}

/**
 * Execute a reminder routine:
 *   1. Create an action task for the owner.
 *   2. Send a web-push notification to the owner.
 */
async function executeReminderRoutine({ routine, supabaseUrl, serviceKey }) {
  const { user_id, payload, name } = routine;
  const title = (typeof payload?.title === 'string' && payload.title.trim()) ? payload.title.trim() : name;

  const taskId = await createTask(supabaseUrl, serviceKey, {
    user_id,
    type: 'action',
    description: title,
    status: 'pending',
    needs_follow_up: false,
  });

  if (!taskId) {
    console.error('[routines] reminder: createTask failed', { routineId: routine.id });
    return false;
  }

  console.log('[routines] reminder task created', { taskId, routineId: routine.id });

  // Push is best-effort — task creation already counts as success.
  const pushed = await sendOwnerPush({
    userId: user_id,
    title: 'Ra7etBal · Reminder',
    body: title,
    supabaseUrl,
    serviceKey,
  });
  if (!pushed) {
    console.warn('[routines] reminder push not delivered (no subscriptions?)', { routineId: routine.id });
  }

  return true;
}

/**
 * Execute a delegation routine:
 *   1. Resolve person by UUID.
 *   2. Create a delegation task (needs_follow_up=true).
 *   3. Set confirmation_url on the task.
 *   4. Send WhatsApp message.
 *   5. The existing escalation cron handles follow-up automatically.
 *
 * Returns true on success, 'missing_person' if person cannot be resolved,
 * or false on other failures.
 */
async function executeDelegationRoutine({ routine, supabaseUrl, serviceKey, appBaseUrl }) {
  const { user_id, payload } = routine;
  const { person_id, message } = payload || {};

  if (!person_id || !message) {
    console.error('[routines] delegation: missing person_id or message in payload', { routineId: routine.id });
    return false;
  }

  // Resolve person by ID (scoped to user).
  const person = await resolvePersonById(supabaseUrl, serviceKey, user_id, person_id);
  if (!person) {
    console.warn('[routines] delegation: person not found', { routineId: routine.id, person_id });
    return 'missing_person';
  }
  if (!person.phone) {
    console.warn('[routines] delegation: person has no phone', { routineId: routine.id, person_id });
    return 'missing_person';
  }

  const ownerName = await resolveOwnerName(supabaseUrl, serviceKey, user_id);

  // Create the delegation task.
  const taskId = await createTask(supabaseUrl, serviceKey, {
    user_id,
    type: 'delegation',
    description: message,
    status: 'pending',
    needs_follow_up: true,
    assigned_to: person.name,
  });

  if (!taskId) {
    console.error('[routines] delegation: createTask failed', { routineId: routine.id });
    return false;
  }

  // Build and persist the confirmation URL so the escalation cron can use it.
  const confirmationUrl = `${appBaseUrl}/confirm?task_id=${encodeURIComponent(taskId)}`;
  await fetch(
    `${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ confirmation_url: confirmationUrl }),
    },
  ).catch((err) => console.warn('[routines] failed to patch confirmation_url:', err?.message));

  console.log('[routines] delegation task created', {
    taskId,
    routineId: routine.id,
    assignedTo: person.name,
  });

  // Send WhatsApp — failure is logged but non-fatal (task exists; cron retries).
  try {
    const msgRes = await fetch(`${appBaseUrl}/api/send-whatsapp-task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: person.phone,
        messageText: message,
        confirmationLink: confirmationUrl,
        taskId,
        recipientName: person.name,
        ownerName,
      }),
    });
    if (msgRes.ok) {
      console.log('[routines] delegation WhatsApp sent', { routineId: routine.id, taskId, to: person.name });
    } else {
      const err = await msgRes.json().catch(() => ({}));
      console.error('[routines] delegation WhatsApp failed', {
        routineId: routine.id,
        taskId,
        status: msgRes.status,
        error: err?.error,
      });
    }
  } catch (err) {
    console.error('[routines] delegation WhatsApp threw', { routineId: routine.id, taskId, error: err?.message });
  }

  // Escalation follow-up is handled automatically: the task exists in the
  // tasks table with needs_follow_up=true, so the escalation cron (which runs
  // every 10 min) will fire the follow-up at the 10-min mark and the owner
  // push at the 20-min mark — no explicit scheduling needed here.

  return true;
}

// ── Routine-specific helpers ──────────────────────────────────────────────────

/** Insert a task row and return the new UUID, or null on failure. */
async function createTask(supabaseUrl, serviceKey, fields) {
  const res = await fetch(`${supabaseUrl}/rest/v1/tasks`, {
    method: 'POST',
    headers: { ...supabaseHeaders(serviceKey), Prefer: 'return=representation' },
    body: JSON.stringify(fields),
  });
  const rows = await res.json().catch(() => []);
  if (!res.ok) {
    console.error('[routines] createTask failed', {
      status: res.status,
      message: rows?.message,
      details: rows?.details,
    });
    return null;
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row?.id || null;
}

/** Look up a person by UUID, scoped to the owning user. */
async function resolvePersonById(supabaseUrl, serviceKey, userId, personId) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/people` +
      `?id=eq.${encodeURIComponent(personId)}` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&select=id,name,phone` +
      `&limit=1`,
    { headers: supabaseHeaders(serviceKey) },
  );
  const rows = await res.json().catch(() => []);
  if (!res.ok || !Array.isArray(rows) || rows.length === 0) return null;
  return rows[0];
}

/** Send a web-push to all active subscriptions for a user. */
async function sendOwnerPush({ userId, title, body, supabaseUrl, serviceKey }) {
  const subsRes = await fetch(
    `${supabaseUrl}/rest/v1/push_subscriptions` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&enabled=eq.true` +
      `&select=id,endpoint,p256dh,auth`,
    { headers: supabaseHeaders(serviceKey) },
  );
  const subscriptions = await subsRes.json().catch(() => []);
  if (!subsRes.ok || !Array.isArray(subscriptions) || subscriptions.length === 0) return false;

  const payload = JSON.stringify({ title, body });
  let sent = false;

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { urgency: 'normal', TTL: 600 },
      );
      sent = true;
    } catch (err) {
      const status = err?.statusCode ?? null;
      console.warn('[routines] push failed', { subId: sub.id, status, error: err?.message });
      // Clean up permanently invalid subscriptions.
      if (status === 410 || status === 404) {
        await fetch(
          `${supabaseUrl}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(sub.id)}`,
          { method: 'DELETE', headers: supabaseHeaders(serviceKey) },
        ).catch(() => {});
      }
    }
  }

  return sent;
}

/** Stamp last_run_at on a routine after successful execution. */
async function stampRoutineLastRun(supabaseUrl, serviceKey, routineId, value) {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/routines?id=eq.${encodeURIComponent(routineId)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ last_run_at: value }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[routines] stampRoutineLastRun failed', { routineId, status: res.status, body });
  } else {
    console.log('[routines] last_run_at stamped', { routineId, value });
  }
}

/** Set enabled=false on a routine (e.g. when its referenced person is gone). */
async function disableRoutine(supabaseUrl, serviceKey, routineId) {
  await fetch(
    `${supabaseUrl}/rest/v1/routines?id=eq.${encodeURIComponent(routineId)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(serviceKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ enabled: false }),
    },
  ).catch((err) => console.warn('[routines] disableRoutine failed:', err?.message));
}

// ─────────────────────────────────────────────────────────────────────────────

async function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (secret && auth === `Bearer ${secret}`) return true;

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  const signature = req.headers['upstash-signature'];
  if (!currentSigningKey || !nextSigningKey || !signature) return false;

  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  const candidateBodies = [JSON.stringify(req.body ?? {}), ''];

  for (const body of candidateBodies) {
    try {
      await receiver.verify({ signature, body });
      return true;
    } catch {
      // Try the next body shape. Vercel may expose an empty QStash body as
      // either undefined/{} or an empty string depending on parsing.
    }
  }

  return false;
}
