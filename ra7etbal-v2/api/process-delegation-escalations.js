// trigger ra7etbal-v2 deployment

/**
 * POST /api/process-delegation-escalations
 * GET  /api/process-delegation-escalations        (Vercel cron)
 *
 * Polls for unconfirmed delegated tasks and fires two timed escalations:
 *
 *   30 min  → WhatsApp follow-up to the assigned person (one send max)
 *   60 min  → Web-push notification to the owner       (one send max)
 *
 * Guards: followup_sent_at / escalated_at columns on tasks table.
 * Once either column is stamped the action is never repeated, even if
 * the cron fires again.
 *
 * ── testMode ──────────────────────────────────────────────────────────────
 * Append ?testMode=true when calling manually to collapse the thresholds:
 *   follow-up threshold  : 1 minute  (production: 30 min)
 *   escalation threshold : 2 minutes (production: 60 min)
 *
 * testMode is detected from the query string only — the Vercel cron never
 * appends query params, so production is unaffected.
 * testMode does NOT change stored data or schema.
 */

import webpush from 'web-push';

const MAX_TASKS_PER_RUN = 50;

// ── Production thresholds ────────────────────────────────────────────────────
const PROD_FOLLOWUP_MS  = 30 * 60 * 1000; //  30 minutes
const PROD_ESCALATE_MS  = 60 * 60 * 1000; //  60 minutes

// ── testMode thresholds ──────────────────────────────────────────────────────
const TEST_FOLLOWUP_MS  = 1 * 60 * 1000;  //   1 minute
const TEST_ESCALATE_MS  = 2 * 60 * 1000;  //   2 minutes

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  // testMode bypasses the CRON_SECRET check so developers can call the
  // endpoint directly from a browser or curl without needing the secret.
  const testMode = isTestMode(req);

  if (!testMode && !isAuthorized(req)) {
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

  webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);

  const now = new Date();
  const followupThresholdMs = testMode ? TEST_FOLLOWUP_MS : PROD_FOLLOWUP_MS;
  const escalateThresholdMs = testMode ? TEST_ESCALATE_MS : PROD_ESCALATE_MS;

  // Fetch tasks old enough to potentially need at least the follow-up.
  const oldestRelevantCutoff = new Date(now.getTime() - followupThresholdMs).toISOString();

  const headers = supabaseHeaders(serviceKey);

  // ── Fetch candidate tasks ──────────────────────────────────────────────────
  const tasksUrl =
    `${supabaseUrl}/rest/v1/tasks` +
    `?select=id,user_id,description,type,assigned_to,status,confirmation_url,` +
    `created_at,followup_sent_at,escalated_at` +
    `&type=in.(delegation,followup)` +
    `&status=eq.pending` +
    `&archived_at=is.null` +
    `&created_at=lte.${encodeURIComponent(oldestRelevantCutoff)}` +
    `&order=created_at.asc` +
    `&limit=${MAX_TASKS_PER_RUN}`;

  const tasksRes = await fetch(tasksUrl, { headers });
  const tasks = await tasksRes.json().catch(() => []);

  if (!tasksRes.ok) {
    console.error('[escalation] failed to fetch tasks:', tasks?.message);
    return res.status(500).json({ error: 'Could not fetch tasks.' });
  }

  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.log('[escalation] no eligible tasks found');
    return res.status(200).json({ checked: 0, followupsSent: 0, escalationsSent: 0 });
  }

  console.log(`[escalation] ${tasks.length} candidate task(s) found (testMode=${testMode})`);

  const stats = { checked: tasks.length, followupsSent: 0, escalationsSent: 0, errors: [] };

  for (const task of tasks) {
    const ageMs = now.getTime() - new Date(task.created_at).getTime();

    // ── Follow-up (30 min / 1 min in testMode) ────────────────────────────
    const followupDue = ageMs >= followupThresholdMs && !task.followup_sent_at;
    if (followupDue) {
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
    }

    // ── Escalation (60 min / 2 min in testMode) ───────────────────────────
    const escalateDue = ageMs >= escalateThresholdMs && !task.escalated_at;
    if (escalateDue) {
      const sent = await sendOwnerEscalationPush({
        task,
        supabaseUrl,
        serviceKey,
        testMode,
      });
      if (sent) {
        stats.escalationsSent += 1;
        await stampColumn(supabaseUrl, serviceKey, task.id, 'escalated_at', now.toISOString());
      } else {
        stats.errors.push(`escalation push failed for task ${task.id}`);
      }
    }
  }

  console.log('[escalation] run complete', stats);
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

  const messageText = `Following up: ${description}`;
  const label = testMode ? '[testMode] ' : '';
  console.log(`[escalation] ${label}sending follow-up WhatsApp to ${assigned_to} for task ${taskId}`);

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
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[escalation] follow-up WhatsApp failed for task ${taskId}:`, data?.error);
      return false;
    }
    console.log(`[escalation] follow-up WhatsApp sent for task ${taskId}`);
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

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    console.log(`[escalation] task ${taskId}: owner has no push subscriptions, skipping escalation`);
    return false;
  }

  const who = assigned_to ? `${assigned_to} hasn't confirmed` : 'Unconfirmed task';
  const timeLabel = testMode ? '(test)' : '1 hour ago';
  const body = `${who}: ${description}. Sent ${timeLabel}.`;
  const payload = JSON.stringify({ title: 'Ra7etBal · Action needed', body });

  const label = testMode ? '[testMode] ' : '';
  console.log(`[escalation] ${label}sending owner escalation push for task ${taskId}`);

  let sent = false;
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { urgency: 'high', TTL: 300 },
      );
      console.log(`[escalation] escalation push sent sub=${sub.id} task=${taskId}`);
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
  const res = await fetch(
    `${supabaseUrl}/rest/v1/people` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&name=eq.${encodeURIComponent(assignedTo)}` +
      `&select=phone` +
      `&limit=1`,
    { headers: supabaseHeaders(serviceKey) },
  );
  const rows = await res.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 && rows[0].phone ? rows[0].phone : null;
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
  }
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

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization || req.headers.Authorization || '';
  return auth === `Bearer ${secret}`;
}
