/**
 * POST /api/send-morning-brief-push
 *
 * Scheduled via QStash (not Vercel cron — Hobby plan does not support cron jobs).
 * Fires daily at 05:00 UTC (Gulf morning, GST+4 = 09:00 local).
 * Also callable manually with ?test=1 for debugging.
 *
 * To register the QStash schedule (run once after each new production deployment):
 *
 *   curl -X POST \
 *     "https://qstash.upstash.io/v2/schedules/https%3A%2F%2Fra7etbal-v2.vercel.app%2Fapi%2Fsend-morning-brief-push" \
 *     -H "Authorization: Bearer <QSTASH_TOKEN>" \
 *     -H "Upstash-Cron: 0 5 * * *" \
 *     -H "Upstash-Forward-Authorization: Bearer <CRON_SECRET>" \
 *     -H "Upstash-Method: POST"
 *
 * To verify the schedule exists:
 *
 *   curl -s https://qstash.upstash.io/v2/schedules \
 *     -H "Authorization: Bearer $QSTASH_TOKEN" \
 *     | grep send-morning-brief-push
 *
 * QStash forwards Authorization: Bearer <CRON_SECRET> on every scheduled call
 * so the existing CRON_SECRET auth below works unchanged.
 *
 * Flow:
 *   1. Authorize via CRON_SECRET (or ?test=1 for dry-run)
 *   2. Load all users who have enabled push subscriptions
 *   3. For each user: fetch tasks + people, build brief headline
 *   4. Send push notification with headline as body
 *   5. Clean up expired subscriptions (410/404 responses)
 *
 * Security:
 *   - No tokens, keys, or user emails in logs — only anonymised userId prefix
 *   - No task content in logs — only counts
 *   - CRON_SECRET required for all non-test invocations
 */

import webpush from 'web-push';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── ?register=1 — one-shot QStash schedule registration ─────────────────
  // Reads QSTASH_TOKEN and CRON_SECRET from process.env so no secrets are
  // needed in the request. Safe to call repeatedly (QStash upserts).
  if (isRegisterMode(req)) {
    return handleRegister(res);
  }

  const testMode = isTestMode(req);
  if (!testMode && !isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const config = getConfig();
  if (!config.ok) {
    return res.status(500).json({ success: false, error: 'Server configuration error.', missing: config.missing });
  }

  try {
    webpush.setVapidDetails(
      config.values.vapidSubject,
      config.values.vapidPublicKey,
      config.values.vapidPrivateKey,
    );
  } catch (err) {
    return res.status(500).json({ success: false, error: `VAPID init failed: ${errMsg(err)}` });
  }

  // ── 1. Load all users with enabled push subscriptions ───────────────────
  const subsRes = await fetchSupabase(
    config,
    '/rest/v1/push_subscriptions?select=id,user_id,endpoint,p256dh,auth&enabled=eq.true',
  );
  if (!subsRes.ok) {
    return res.status(500).json({ success: false, error: 'Failed to load push subscriptions.' });
  }
  const allSubs = await subsRes.json().catch(() => []);
  if (!Array.isArray(allSubs) || allSubs.length === 0) {
    return res.status(200).json({ success: true, usersProcessed: 0, reason: 'No enabled push subscriptions.' });
  }

  // Group subscriptions by user_id
  const byUser = new Map();
  for (const sub of allSubs) {
    if (!sub.user_id) continue;
    const bucket = byUser.get(sub.user_id) ?? [];
    bucket.push(sub);
    byUser.set(sub.user_id, bucket);
  }

  let usersProcessed = 0;
  let totalSent = 0;
  let totalFailed = 0;

  for (const [userId, subs] of byUser.entries()) {
    const shortId = userId.slice(0, 8);

    // ── 2. Fetch user's tasks ──────────────────────────────────────────────
    const tasksRes = await fetchSupabase(
      config,
      `/rest/v1/tasks?select=id,description,type,status,assigned_to,due_at,needs_follow_up,escalated_at,confirmed_at,created_at,archived_at&user_id=eq.${encodeURIComponent(userId)}&archived_at=is.null&order=created_at.desc&limit=60`,
    );
    if (!tasksRes.ok) {
      console.error(`[morning-brief-push] userId=${shortId} — failed to fetch tasks`);
      continue;
    }
    const tasks = await tasksRes.json().catch(() => []);

    // ── 3. Build brief headline ────────────────────────────────────────────
    const headline = buildBriefHeadline(tasks);

    if (testMode) {
      // In test mode: return first user's headline without sending
      return res.status(200).json({
        testMode: true,
        usersFound: byUser.size,
        sampleUserId: shortId,
        headline,
        taskCounts: summariseCounts(tasks),
      });
    }

    // ── 4. Send push to all of this user's subscriptions ──────────────────
    const payload = JSON.stringify({
      title: 'Ra7etBal — Morning Brief',
      body: headline,
    });

    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { urgency: 'normal', TTL: 3600 }, // 1-hour TTL — morning brief is not time-critical to the second
        );
        totalSent += 1;
      } catch (err) {
        totalFailed += 1;
        const statusCode = err?.statusCode ?? null;
        console.error(`[morning-brief-push] userId=${shortId} push failed statusCode=${statusCode}`);
        if (statusCode === 410 || statusCode === 404) {
          await removeExpiredSub(config, sub.id, shortId);
        }
      }
    }

    usersProcessed += 1;
  }

  return res.status(200).json({
    success: true,
    usersProcessed,
    totalSent,
    totalFailed,
  });
}

// ---------------------------------------------------------------------------
// Brief headline builder
// ---------------------------------------------------------------------------

/**
 * Builds a short push notification headline from raw task rows.
 * No imports from src/ — self-contained JS so it runs cleanly in Vercel
 * serverless without bundling the frontend module graph.
 */
function buildBriefHeadline(tasks) {
  const now = new Date();
  const active = tasks.filter(t => t.archived_at == null);

  // Overdue: overdue reminders + escalated pending delegations
  const overdue = active.filter(t => {
    if (t.status !== 'pending') return false;
    if (t.type === 'reminder' && t.due_at && new Date(t.due_at) < now) return true;
    if (t.escalated_at != null) return true;
    return false;
  });
  const overdueIds = new Set(overdue.map(t => t.id));

  // Waiting on: active delegations / followups (excluding overdue)
  const waiting = active.filter(t => {
    if (t.status !== 'pending') return false;
    if (overdueIds.has(t.id)) return false;
    if (t.type === 'delegation' && t.assigned_to) return true;
    if (t.type === 'followup') return true;
    if (t.needs_follow_up && t.assigned_to) return true;
    return false;
  });
  const waitingIds = new Set(waiting.map(t => t.id));

  // Needs attention: owner tasks + reminders due today (not overdue)
  const attention = active.filter(t => {
    if (t.status !== 'pending') return false;
    if (overdueIds.has(t.id)) return false;
    if (waitingIds.has(t.id)) return false;
    if (t.type === 'reminder' && t.due_at) {
      const due = new Date(t.due_at);
      return due >= now && isSameLocalDay(due, now);
    }
    const assignee = (t.assigned_to ?? '').trim().toLowerCase();
    return !assignee || assignee === 'me';
  });

  const totalUrgent = attention.length + overdue.length;

  // ── Compose headline ─────────────────────────────────────────────────────
  if (totalUrgent === 0 && waiting.length === 0) {
    return "You're clear this morning. No open loops.";
  }

  const parts = [];

  if (totalUrgent > 0) {
    const n = spokenCount(totalUrgent);
    const noun = totalUrgent === 1 ? 'thing needs' : 'things need';
    parts.push(`${n} ${noun} your attention`);
  }

  if (waiting.length > 0) {
    // Name up to 2 people waiting
    const names = [...new Set(
      waiting
        .map(t => (t.assigned_to ?? '').trim())
        .filter(Boolean)
    )].slice(0, 2).map(capitalise);

    if (names.length === 1) {
      parts.push(`waiting on ${names[0]}`);
    } else if (names.length === 2) {
      parts.push(`waiting on ${names[0]} and ${names[1]}`);
    } else {
      parts.push(`${spokenCount(waiting.length)} pending confirmations`);
    }
  }

  const summary = parts.join('. ');
  return summary.charAt(0).toUpperCase() + summary.slice(1) + '.';
}

function isSameLocalDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function capitalise(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function spokenCount(n) {
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
  return n < words.length ? words[n] : String(n);
}

function summariseCounts(tasks) {
  const active = tasks.filter(t => t.archived_at == null);
  return {
    total: active.length,
    pending: active.filter(t => t.status === 'pending').length,
    done: active.filter(t => t.status === 'done').length,
  };
}

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

async function removeExpiredSub(config, subId, shortUserId) {
  try {
    await fetch(
      `${config.values.supabaseUrl}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(subId)}`,
      { method: 'DELETE', headers: supabaseHeaders(config.values.serviceRoleKey) },
    );
  } catch (err) {
    console.error(`[morning-brief-push] userId=${shortUserId} failed to remove expired sub: ${errMsg(err)}`);
  }
}

function fetchSupabase(config, path) {
  return fetch(`${config.values.supabaseUrl}${path}`, {
    headers: supabaseHeaders(config.values.serviceRoleKey),
  });
}

function supabaseHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

// ---------------------------------------------------------------------------
// ?register=1 — one-shot QStash schedule registration
// ---------------------------------------------------------------------------

function isRegisterMode(req) {
  if (req.query?.register === '1') return true;
  try {
    return new URL(req.url, 'https://ra7etbal.local').searchParams.get('register') === '1';
  } catch {
    return false;
  }
}

async function handleRegister(res) {
  const qstashToken = process.env.QSTASH_TOKEN;
  const cronSecret = process.env.CRON_SECRET;

  if (!qstashToken) return res.status(500).json({ error: 'QSTASH_TOKEN not set' });
  if (!cronSecret) return res.status(500).json({ error: 'CRON_SECRET not set' });

  const TARGET_URL = 'https://ra7etbal-v2.vercel.app/api/send-morning-brief-push';
  const CRON_EXPR = '0 5 * * *';
  const encoded = encodeURIComponent(TARGET_URL);

  let resp;
  try {
    resp = await fetch(`https://qstash.upstash.io/v2/schedules/${encoded}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${qstashToken}`,
        'Upstash-Cron': CRON_EXPR,
        'Upstash-Forward-Authorization': `Bearer ${cronSecret}`,
        'Upstash-Method': 'POST',
      },
    });
  } catch (err) {
    return res.status(500).json({ error: `QStash network error: ${errMsg(err)}` });
  }

  const body = await resp.json().catch(() => ({}));
  return res.status(resp.status).json({
    qstashStatus: resp.status,
    scheduleId: body.scheduleId ?? body.schedule_id ?? null,
    targetUrl: TARGET_URL,
    method: 'POST',
    cron: CRON_EXPR,
    raw: body,
  });
}

function isTestMode(req) {
  if (req.query?.test === '1') return true;
  try {
    return new URL(req.url, 'https://ra7etbal.local').searchParams.get('test') === '1';
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization || req.headers.Authorization;
  return auth === `Bearer ${secret}`;
}

function getConfig() {
  const values = {
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT,
  };
  const missing = Object.entries(values).filter(([, v]) => !v).map(([k]) => k);
  return missing.length === 0 ? { ok: true, values } : { ok: false, missing };
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err);
}
