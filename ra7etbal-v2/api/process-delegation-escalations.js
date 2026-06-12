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
