/**
 * POST /api/send-morning-brief-push
 *
 * Scheduled via QStash (not Vercel cron — Hobby plan does not support cron jobs).
 * Fires every 15 minutes (*/15 * * * *).
 * Each run checks per-user local time and sends only when it matches their
 * preferred morning_brief_time window. Duplicate sends are prevented by
 * last_morning_brief_sent_at on profiles.
 * Also callable manually with ?test=1 for debugging.
 *
 * To register the QStash schedule (run once after each new production deployment):
 *
 *   curl -X POST \
 *     "https://qstash.upstash.io/v2/schedules/https%3A%2F%2Fra7etbal.com%2Fapi%2Fsend-morning-brief-push" \
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
  // Requires Authorization: Bearer <CRON_SECRET> — same guard as the send path.
  // Reads QSTASH_TOKEN from process.env so no additional secrets are needed.
  // Safe to call repeatedly (QStash upserts on the same destination URL).
  if (isRegisterMode(req)) {
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
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
  let totalSkipped = 0;

  const now = new Date();

  for (const [userId, subs] of byUser.entries()) {
    const shortId = userId.slice(0, 8);

    // ── 2. Fetch user's profile (brief prefs + last sent) ─────────────────
    const profileRes = await fetchSupabase(
      config,
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=morning_brief_enabled,morning_brief_timezone,morning_brief_time,last_morning_brief_sent_at,evening_brief_enabled,evening_brief_time,last_evening_brief_sent_at`,
    );
    const profiles = profileRes.ok ? await profileRes.json().catch(() => []) : [];
    const profile = profiles?.[0] ?? {};

    const timezone = profile.morning_brief_timezone || 'Europe/Istanbul';
    const userLocalHHMM = toLocalHHMM(now, timezone);
    const todayLocalDate = toLocalDateString(now, timezone);

    // ── Determine which briefs to send this tick ──────────────────────────
    const shouldSendMorning = (() => {
      if (profile.morning_brief_enabled === false) return false;
      const lastSentAt = profile.last_morning_brief_sent_at ?? null;
      if (lastSentAt && toLocalDateString(new Date(lastSentAt), timezone) === todayLocalDate) return false;
      return isInWindow(userLocalHHMM, profile.morning_brief_time || '08:00');
    })();

    const shouldSendEvening = (() => {
      if (!profile.evening_brief_enabled) return false; // off by default
      const lastSentAt = profile.last_evening_brief_sent_at ?? null;
      if (lastSentAt && toLocalDateString(new Date(lastSentAt), timezone) === todayLocalDate) return false;
      return isInWindow(userLocalHHMM, profile.evening_brief_time || '20:00');
    })();

    if (!shouldSendMorning && !shouldSendEvening) {
      totalSkipped += 1;
      continue;
    }

    // ── 3. Fetch user's tasks (shared by both briefs) ─────────────────────
    const tasksRes = await fetchSupabase(
      config,
      `/rest/v1/tasks?select=id,description,type,status,assigned_to,due_at,needs_follow_up,escalated_at,confirmed_at,created_at,archived_at&user_id=eq.${encodeURIComponent(userId)}&archived_at=is.null&order=created_at.desc&limit=60`,
    );
    if (!tasksRes.ok) {
      console.error(`[morning-brief-push] userId=${shortId} — failed to fetch tasks`);
      continue;
    }
    const tasks = await tasksRes.json().catch(() => []);

    if (testMode) {
      const headline = shouldSendMorning
        ? buildBriefHeadline(tasks)
        : buildEveningBriefHeadline(tasks, timezone, now);
      return res.status(200).json({
        testMode: true,
        usersFound: byUser.size,
        sampleUserId: shortId,
        timezone,
        userLocalHHMM,
        shouldSendMorning,
        shouldSendEvening,
        headline,
        taskCounts: summariseCounts(tasks),
      });
    }

    // ── Helper: send push to all subscriptions for this user ──────────────
    const sendPush = async (title, body) => {
      const payload = JSON.stringify({ title, body });
      let sent = false;
      for (const sub of subs) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
            { urgency: 'normal', TTL: 3600 },
          );
          totalSent += 1;
          sent = true;
        } catch (err) {
          totalFailed += 1;
          const statusCode = err?.statusCode ?? null;
          console.error(`[morning-brief-push] userId=${shortId} push failed statusCode=${statusCode}`);
          if (statusCode === 410 || statusCode === 404) {
            await removeExpiredSub(config, sub.id, shortId);
          }
        }
      }
      return sent;
    };

    // ── 4. Send morning brief ─────────────────────────────────────────────
    if (shouldSendMorning) {
      const headline = buildBriefHeadline(tasks);
      const sent = await sendPush('Ra7etBal — Morning Brief', headline);
      if (sent) {
        await fetchSupabase(
          config,
          `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
          { method: 'PATCH', body: JSON.stringify({ last_morning_brief_sent_at: now.toISOString() }) },
        );
      }
    }

    // ── 5. Send evening brief ─────────────────────────────────────────────
    if (shouldSendEvening) {
      const headline = buildEveningBriefHeadline(tasks, timezone, now);
      const sent = await sendPush('Ra7etBal — Evening Brief', headline);
      if (sent) {
        await fetchSupabase(
          config,
          `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
          { method: 'PATCH', body: JSON.stringify({ last_evening_brief_sent_at: now.toISOString() }) },
        );
      }
    }

    usersProcessed += 1;
  }

  return res.status(200).json({
    success: true,
    usersProcessed,
    totalSent,
    totalFailed,
    totalSkipped,
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

function spokenDesc(raw) {
  const s = (raw ?? '').trim().replace(/[.!?]+$/, '').trim();
  return s.length > 40 ? s.slice(0, 40).trimEnd() + '…' : s;
}

// ---------------------------------------------------------------------------
// Evening brief headline builder
// ---------------------------------------------------------------------------

/**
 * Builds a calm, closing push notification headline for the end of day.
 *
 * Tone: reassuring, not nagging. Closes the loop without piling on.
 *
 * Sections (each conditional):
 *   1. What got done today
 *   2. What is still open tonight
 *   3. What is waiting on others
 *   4. Reassurance close
 */
function buildEveningBriefHeadline(tasks, timezone, now) {
  now = now || new Date();
  const active = tasks.filter(t => t.archived_at == null);
  const todayLocalDate = toLocalDateString(now, timezone);

  // ── Done today: confirmed in the user's local calendar day ───────────────
  const doneToday = tasks.filter(t => {
    if (t.status !== 'done' || !t.confirmed_at) return false;
    return toLocalDateString(new Date(t.confirmed_at), timezone) === todayLocalDate;
  });

  // ── Waiting on others: pending delegations/followups ─────────────────────
  const waiting = active.filter(t => {
    if (t.status !== 'pending') return false;
    if (t.type === 'delegation' && t.assigned_to) return true;
    if (t.type === 'followup') return true;
    if (t.needs_follow_up && t.assigned_to) return true;
    return false;
  });
  const waitingIds = new Set(waiting.map(t => t.id));

  // ── Still open tonight: overdue reminders + owner tasks ──────────────────
  const stillOpen = active.filter(t => {
    if (t.status !== 'pending') return false;
    if (waitingIds.has(t.id)) return false;
    // Overdue reminder
    if (t.type === 'reminder' && t.due_at && new Date(t.due_at) < now) return true;
    // Reminder due today
    if (t.type === 'reminder' && t.due_at) {
      return toLocalDateString(new Date(t.due_at), timezone) === todayLocalDate;
    }
    // Owner task (unassigned or self)
    const assignee = (t.assigned_to ?? '').trim().toLowerCase();
    return !assignee || assignee === 'me';
  });

  // ── Compose headline ──────────────────────────────────────────────────────
  const parts = [];

  // Done today
  if (doneToday.length === 1) {
    const t = doneToday[0];
    const who = t.assigned_to?.trim();
    const isDelegated = t.type === 'delegation' || t.type === 'followup' ||
      (who && who.toLowerCase() !== 'me');
    if (isDelegated && who) {
      parts.push(`${capitalise(who)} confirmed ${spokenDesc(t.description)}.`);
    } else {
      parts.push(`You wrapped up ${spokenDesc(t.description)} today.`);
    }
  } else if (doneToday.length === 2) {
    const delegated = doneToday.filter(t => {
      const who = t.assigned_to?.trim()?.toLowerCase();
      return t.type === 'delegation' || t.type === 'followup' || (who && who !== 'me');
    });
    if (delegated.length === 2) {
      const names = [...new Set(delegated.map(t => capitalise(t.assigned_to?.trim())).filter(Boolean))];
      if (names.length === 2) parts.push(`${names[0]} and ${names[1]} both confirmed today.`);
      else if (names.length === 1) parts.push(`${names[0]} confirmed two things today.`);
      else parts.push('Two things were confirmed today.');
    } else {
      parts.push(`${spokenCount(doneToday.length)} things got done today.`);
    }
  } else if (doneToday.length > 2) {
    parts.push(`${spokenCount(doneToday.length)} things wrapped up today.`);
  }

  // Still open
  if (stillOpen.length === 1) {
    parts.push(`${spokenDesc(stillOpen[0].description)} is still open.`);
  } else if (stillOpen.length > 1) {
    parts.push(`${spokenCount(stillOpen.length)} things are still open.`);
  }

  // Waiting on others
  if (waiting.length > 0) {
    const names = [...new Set(
      waiting.map(t => (t.assigned_to ?? '').trim()).filter(Boolean)
    )].slice(0, 2).map(capitalise);

    if (names.length === 1) {
      parts.push(`You're waiting on ${names[0]}.`);
    } else if (names.length === 2) {
      parts.push(`You're waiting on ${names[0]} and ${names[1]}.`);
    } else {
      parts.push(`${spokenCount(waiting.length)} people haven't confirmed yet.`);
    }
  }

  // Reassurance close
  const hasOpenItems = stillOpen.length > 0;
  const hasWaiting = waiting.length > 0;

  if (parts.length === 0) {
    return "Everything important is handled for today. You're clear for the evening.";
  }

  if (!hasOpenItems && !hasWaiting) {
    parts.push("Nothing else needs you tonight.");
  } else if (!hasOpenItems && hasWaiting) {
    parts.push("Nothing you need to act on tonight.");
  } else {
    parts.push("Nothing urgent tonight.");
  }

  // Prefix with calm opener
  const opener = doneToday.length > 0 ? "Quick wrap-up." : "End of day.";
  return `${opener} ${parts.join(' ')}`;
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

function fetchSupabase(config, path, opts = {}) {
  return fetch(`${config.values.supabaseUrl}${path}`, {
    method: opts.method ?? 'GET',
    headers: {
      ...supabaseHeaders(config.values.serviceRoleKey),
      ...(opts.body ? { 'Content-Type': 'application/json', Prefer: 'return=minimal' } : {}),
    },
    ...(opts.body ? { body: opts.body } : {}),
  });
}

// ---------------------------------------------------------------------------
// Timezone helpers (native Intl — no external dependency)
// ---------------------------------------------------------------------------

/**
 * Returns the local date string "YYYY-MM-DD" for a given Date in a timezone.
 * e.g. toLocalDateString(new Date(), "America/New_York") → "2026-06-13"
 */
function toLocalDateString(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value ?? '';
    const m = parts.find(p => p.type === 'month')?.value ?? '';
    const d = parts.find(p => p.type === 'day')?.value ?? '';
    return `${y}-${m}-${d}`;
  } catch {
    // Fallback: UTC date
    return date.toISOString().slice(0, 10);
  }
}

/**
 * Returns the local time as "HH:MM" for a given Date in a timezone.
 * e.g. toLocalHHMM(new Date(), "America/Chicago") → "07:45"
 */
function toLocalHHMM(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const h = parts.find(p => p.type === 'hour')?.value ?? '00';
    const m = parts.find(p => p.type === 'minute')?.value ?? '00';
    return `${h}:${m}`;
  } catch {
    return '00:00';
  }
}

/**
 * Returns true if currentHHMM falls within the 15-minute window
 * starting at targetHHMM.
 *
 * e.g. isInWindow("08:07", "08:00") → true
 *      isInWindow("08:15", "08:00") → false
 */
function isInWindow(currentHHMM, targetHHMM) {
  const toMinutes = hhmm => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  const current = toMinutes(currentHHMM);
  const target = toMinutes(targetHHMM);
  return current >= target && current < target + 15;
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

  const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://ra7etbal.com').trim();
  const TARGET_URL = `${APP_BASE_URL}/api/send-morning-brief-push`;
  const CRON_EXPR = '0 5 * * *';

  // QStash expects the destination URL raw (not percent-encoded) in the path.
  // Encoding turns https:// into https%3A%2F%2F which QStash rejects as missing scheme.
  let resp;
  try {
    resp = await fetch(`https://qstash.upstash.io/v2/schedules/${TARGET_URL}`, {
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
