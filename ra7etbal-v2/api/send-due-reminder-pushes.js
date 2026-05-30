import webpush from 'web-push';

const MAX_TASKS_PER_RUN = 50;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const config = getConfig();
  if (!config.ok) {
    return res.status(500).json({
      success: false,
      error: 'Reminder push is not configured.',
      missing: config.missing,
    });
  }

  webpush.setVapidDetails(
    config.values.vapidSubject,
    config.values.vapidPublicKey,
    config.values.vapidPrivateKey,
  );

  const runStartedAt = new Date().toISOString();

  try {
    const tasks = await fetchDueReminderTasks(config.values, runStartedAt);
    if (tasks.length === 0) {
      return res.status(200).json({
        success: true,
        checked: 0,
        sent: 0,
        skipped: 0,
        failed: 0,
        markedSent: 0,
      });
    }

    const subscriptionsByUser = await fetchSubscriptionsByUser(config.values, tasks);
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let markedSent = 0;

    for (const task of tasks) {
      const subscriptions = subscriptionsByUser.get(task.user_id) ?? [];
      if (subscriptions.length === 0) {
        skipped += 1;
        continue;
      }

      const result = await sendTaskReminder(task, subscriptions);
      sent += result.sent;
      failed += result.failed;

      if (result.sent > 0) {
        await markTaskPushSent(config.values, task.id, runStartedAt);
        markedSent += 1;
      }
    }

    return res.status(200).json({
      success: true,
      checked: tasks.length,
      sent,
      skipped,
      failed,
      markedSent,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: 'Could not send due reminder pushes.',
      details: error instanceof Error ? error.message : 'Unexpected server error.',
    });
  }
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const authorization = req.headers.authorization || req.headers.Authorization;
  return authorization === `Bearer ${secret}`;
}

function getConfig() {
  const values = {
    supabaseUrl: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY,
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY,
    vapidSubject: process.env.VAPID_SUBJECT,
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return missing.length === 0 ? { ok: true, values } : { ok: false, missing };
}

async function fetchDueReminderTasks(config, nowIso) {
  const url =
    `${config.supabaseUrl}/rest/v1/tasks` +
    '?select=id,user_id,description,due_at' +
    '&type=eq.reminder' +
    '&status=eq.pending' +
    '&archived_at=is.null' +
    '&last_push_sent_at=is.null' +
    `&due_at=lte.${encodeURIComponent(nowIso)}` +
    '&order=due_at.asc' +
    `&limit=${MAX_TASKS_PER_RUN}`;

  const response = await fetch(url, {
    headers: supabaseHeaders(config),
  });
  const data = await readJson(response);

  if (!response.ok) {
    throw new Error(data?.message || 'Could not load due reminder tasks.');
  }

  return Array.isArray(data) ? data : [];
}

async function fetchSubscriptionsByUser(config, tasks) {
  const userIds = [...new Set(tasks.map((task) => task.user_id).filter(Boolean))];
  const subscriptionsByUser = new Map();

  if (userIds.length === 0) return subscriptionsByUser;

  const url =
    `${config.supabaseUrl}/rest/v1/push_subscriptions` +
    '?select=id,user_id,endpoint,p256dh,auth,expiration_time' +
    '&enabled=eq.true' +
    `&user_id=in.(${userIds.join(',')})`;

  const response = await fetch(url, {
    headers: supabaseHeaders(config),
  });
  const data = await readJson(response);

  if (!response.ok) {
    throw new Error(data?.message || 'Could not load push subscriptions.');
  }

  for (const subscription of Array.isArray(data) ? data : []) {
    const list = subscriptionsByUser.get(subscription.user_id) ?? [];
    list.push(subscription);
    subscriptionsByUser.set(subscription.user_id, list);
  }

  return subscriptionsByUser;
}

async function sendTaskReminder(task, subscriptions) {
  const payload = JSON.stringify({
    title: 'Ra7etBal reminder',
    body: `${task.description} is due now.`,
  });

  let sent = 0;
  let failed = 0;

  for (const row of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: row.endpoint,
          keys: {
            p256dh: row.p256dh,
            auth: row.auth,
          },
        },
        payload,
      );
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  return { sent, failed };
}

async function markTaskPushSent(config, taskId, sentAt) {
  const url =
    `${config.supabaseUrl}/rest/v1/tasks` +
    `?id=eq.${encodeURIComponent(taskId)}` +
    '&last_push_sent_at=is.null';

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(config),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ last_push_sent_at: sentAt }),
  });

  if (!response.ok) {
    const data = await readJson(response);
    throw new Error(data?.message || 'Could not mark reminder push as sent.');
  }
}

function supabaseHeaders(config) {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

async function readJson(response) {
  return response.json().catch(() => null);
}
