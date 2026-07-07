import webpush from 'web-push';

const MAX_TASKS_PER_RUN = 50;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const testMode = isTestMode(req);

  if (!testMode && !isAuthorized(req)) {
    console.warn('[safety-net] unauthorized scheduled caller', getUnauthorizedCallerDiagnostic(req));
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const config = getConfig();
  const vapidKeysLoaded = hasVapidKeys();
  if (!config.ok) {
    if (testMode) {
      return res.status(500).json({
        success: false,
        testMode: true,
        remindersFound: 0,
        subscriptionsFound: 0,
        vapidKeysLoaded,
        webPushInitialized: false,
        pushSuccessCount: 0,
        pushFailureCount: 0,
        errors: [`Missing config: ${config.missing.join(', ')}`],
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Reminder push is not configured.',
      missing: config.missing,
    });
  }

  let webPushInitialized = false;
  try {
    webpush.setVapidDetails(
      config.values.vapidSubject,
      config.values.vapidPublicKey,
      config.values.vapidPrivateKey,
    );
    webPushInitialized = true;
  } catch (error) {
    if (testMode) {
      return res.status(500).json({
        success: false,
        testMode: true,
        remindersFound: 0,
        subscriptionsFound: 0,
        vapidKeysLoaded,
        webPushInitialized,
        pushSuccessCount: 0,
        pushFailureCount: 0,
        errors: [getErrorMessage(error)],
      });
    }

    throw error;
  }

  const runStartedAt = new Date().toISOString();

  try {
    const tasks = await fetchDueReminderTasks(config.values, runStartedAt);
    if (tasks.length === 0) {
      if (testMode) {
        return res.status(200).json({
          success: true,
          testMode: true,
          remindersFound: 0,
          subscriptionsFound: 0,
          vapidKeysLoaded,
          webPushInitialized,
          pushSuccessCount: 0,
          pushFailureCount: 0,
          errors: [],
        });
      }

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
    const errors = [];
    const debugTasks = [];

    for (const task of tasks) {
      const subscriptions = subscriptionsByUser.get(task.user_id) ?? [];
      if (subscriptions.length === 0) {
        skipped += 1;
        debugTasks.push({
          id: task.id,
          description: task.description,
          due_at: task.due_at,
          user_id: task.user_id,
          status: task.status,
          last_push_sent_at: task.last_push_sent_at ?? null,
          subscriptionsFound: 0,
          reason: 'skipped: no enabled push subscriptions found for user_id',
        });
        continue;
      }

      const claimed = await claimTaskForPush(config.values, task.id, runStartedAt);
      if (!claimed) {
        skipped += 1;
        debugTasks.push({
          id: task.id,
          description: task.description,
          due_at: task.due_at,
          user_id: task.user_id,
          status: task.status,
          last_push_sent_at: task.last_push_sent_at ?? null,
          subscriptionsFound: subscriptions.length,
          reason: 'skipped: already claimed or sent',
        });
        continue;
      }

      const overdueMs = new Date(runStartedAt).getTime() - new Date(task.due_at).getTime();
      const overdueSec = Math.round(overdueMs / 1000);
      console.log(`[safety-net] sending overdue reminder push after 30s grace — taskId=${task.id} overdue=${overdueSec}s due_at=${task.due_at}`);
      const result = await sendTaskReminder(task, subscriptions, config.values);
      sent += result.sent;
      failed += result.failed;
      errors.push(...result.errors);

      let markError = null;
      if (result.sent > 0) {
        try {
          await markTaskPushSent(config.values, task.id, runStartedAt);
          markedSent += 1;
        } catch (err) {
          markError = getErrorMessage(err);
          errors.push(`markTaskPushSent failed for task ${task.id}: ${markError}`);
        }
      } else {
        await clearTaskPushClaim(config.values, task.id, runStartedAt);
      }

      debugTasks.push({
        id: task.id,
        description: task.description,
        due_at: task.due_at,
        user_id: task.user_id,
        status: task.status,
        last_push_sent_at: task.last_push_sent_at ?? null,
        subscriptionsFound: subscriptions.length,
        sendResult: {
          sent: result.sent,
          failed: result.failed,
          errors: result.errors,
          perSubscription: result.perSubscription,
        },
        markedSent: result.sent > 0 && markError === null,
        markError,
        reason: result.sent > 0 ? 'sent' : 'send_failed',
      });
    }

    if (testMode) {
      return res.status(200).json({
        success: true,
        testMode: true,
        remindersFound: tasks.length,
        subscriptionsFound: countSubscriptions(subscriptionsByUser),
        vapidKeysLoaded,
        webPushInitialized,
        pushSuccessCount: sent,
        pushFailureCount: failed,
        skipped,
        markedSent,
        errors,
        debug: debugTasks,
      });
    }

    return res.status(200).json({
      success: true,
      checked: tasks.length,
      sent,
      skipped,
      failed,
      markedSent,
      debug: debugTasks,
    });
  } catch (error) {
    if (testMode) {
      return res.status(500).json({
        success: false,
        testMode: true,
        remindersFound: 0,
        subscriptionsFound: 0,
        vapidKeysLoaded,
        webPushInitialized,
        pushSuccessCount: 0,
        pushFailureCount: 0,
        errors: [getErrorMessage(error)],
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Could not send due reminder pushes.',
      details: error instanceof Error ? error.message : 'Unexpected server error.',
    });
  }
}

function isTestMode(req) {
  if (req.query?.test === '1') return true;

  try {
    const url = new URL(req.url, 'https://ra7etbal.local');
    return url.searchParams.get('test') === '1';
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;

  const authorization = req.headers.authorization || req.headers.Authorization;
  return authorization === `Bearer ${secret}`;
}

export function getUnauthorizedCallerDiagnostic(req) {
  const headers = req.headers || {};
  const authorization = headers.authorization || headers.Authorization || '';
  const qstashHeaders = Object.keys(headers)
    .filter((key) => key.toLowerCase().startsWith('upstash-'))
    .sort();

  return {
    method: req.method,
    url: req.url,
    host: headers.host,
    userAgent: headers['user-agent'] || headers['User-Agent'] || null,
    hasAuthorization: Boolean(authorization),
    authorizationScheme: typeof authorization === 'string' && authorization.includes(' ')
      ? authorization.split(' ', 1)[0]
      : null,
    qstashHeaders,
    vercelId: headers['x-vercel-id'] || headers['X-Vercel-Id'] || null,
  };
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

function hasVapidKeys() {
  return Boolean(
    (process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY) &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT,
  );
}

async function fetchDueReminderTasks(config, nowIso) {
  // Safety net: catch reminders that QStash missed (30+ seconds overdue and still unsent).
  // QStash delivers within ~5 s of due_at; 30 s gives enough margin without a noticeable delay.
  // Previously 2 minutes — reduced so users don't wait a full 2 min if QStash skips.
  const thirtySecondsAgo = new Date(new Date(nowIso).getTime() - 30 * 1000).toISOString();
  console.log(`[safety-net] scanning for reminders overdue by 30+ seconds (threshold=${thirtySecondsAgo})`);

  const url =
    `${config.supabaseUrl}/rest/v1/tasks` +
    '?select=id,user_id,description,due_at,status,last_push_sent_at' +
    '&type=eq.reminder' +
    '&status=eq.pending' +
    '&archived_at=is.null' +
    '&last_push_sent_at=is.null' +
    `&due_at=lte.${encodeURIComponent(thirtySecondsAgo)}` +
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

  for (const [userId, subscriptions] of subscriptionsByUser.entries()) {
    const deduped = dedupeSubscriptionsByEndpoint(subscriptions);
    if (deduped.length !== subscriptions.length) {
      console.log(`[safety-net] deduped subscriptions by endpoint — userId=${userId} raw=${subscriptions.length} unique=${deduped.length}`);
    }
    subscriptionsByUser.set(userId, deduped);
  }

  return subscriptionsByUser;
}

async function removeExpiredSubscription(config, subId) {
  try {
    await fetch(
      `${config.supabaseUrl}/rest/v1/push_subscriptions?id=eq.${encodeURIComponent(subId)}`,
      {
        method: 'DELETE',
        headers: supabaseHeaders(config),
      },
    );
  } catch {
    // best-effort — don't block reminder flow
  }
}

async function sendTaskReminder(task, subscriptions, config) {
  const payload = JSON.stringify({
    title: 'Ra7etBal reminder',
    body: `${task.description} is due now.`,
  });

  let sent = 0;
  let failed = 0;
  const errors = [];
  const perSubscription = [];

  for (const row of subscriptions) {
    const endpointShort = row.endpoint ? row.endpoint.slice(-40) : '(missing)';
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
        // urgency:high = APNs priority 10 (immediate delivery, not batched).
        // TTL:60 = discard after 60 s if device unreachable (reminder is time-sensitive).
        { urgency: 'high', TTL: 60 },
      );
      sent += 1;
      perSubscription.push({
        subscriptionId: row.id,
        endpointTail: endpointShort,
        result: 'sent',
      });
    } catch (error) {
      failed += 1;
      const statusCode = error?.statusCode ?? null;
      const detail = {
        subscriptionId: row.id,
        endpointTail: endpointShort,
        result: 'failed',
        message: error instanceof Error ? error.message : String(error),
        statusCode,
        body: error?.body ?? null,
      };
      perSubscription.push(detail);
      errors.push(
        `sub=${row.id} status=${detail.statusCode} msg=${detail.message} body=${JSON.stringify(detail.body)}`,
      );

      // 410 Gone or 404 Not Found = permanently invalid subscription. Remove it.
      if (statusCode === 410 || statusCode === 404) {
        await removeExpiredSubscription(config, row.id);
      }
    }
  }

  return { sent, failed, errors, perSubscription };
}

async function markTaskPushSent(config, taskId, sentAt) {
  const url =
    `${config.supabaseUrl}/rest/v1/tasks` +
    `?id=eq.${encodeURIComponent(taskId)}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(config),
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      last_push_sent_at: sentAt,
      status: 'done',
      confirmed_at: sentAt,
    }),
  });

  if (!response.ok) {
    const data = await readJson(response);
    throw new Error(data?.message || 'Could not mark reminder push as sent.');
  }
}

async function claimTaskForPush(config, taskId, sentAt) {
  const url =
    `${config.supabaseUrl}/rest/v1/tasks` +
    `?id=eq.${encodeURIComponent(taskId)}` +
    '&type=eq.reminder' +
    '&status=eq.pending' +
    '&archived_at=is.null' +
    '&last_push_sent_at=is.null' +
    '&select=id';

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      ...supabaseHeaders(config),
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ last_push_sent_at: sentAt }),
  });

  if (!response.ok) {
    const data = await readJson(response);
    throw new Error(data?.message || 'Could not claim reminder push.');
  }

  const rows = await readJson(response);
  return Array.isArray(rows) && rows.length > 0;
}

async function clearTaskPushClaim(config, taskId, sentAt) {
  try {
    await fetch(
      `${config.supabaseUrl}/rest/v1/tasks` +
        `?id=eq.${encodeURIComponent(taskId)}` +
        `&last_push_sent_at=eq.${encodeURIComponent(sentAt)}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders(config), Prefer: 'return=minimal' },
        body: JSON.stringify({ last_push_sent_at: null }),
      },
    );
  } catch {
    // Best effort. The next normal reminder mutation can re-arm the job.
  }
}

export function dedupeSubscriptionsByEndpoint(subscriptions) {
  const seen = new Set();
  const unique = [];
  for (const subscription of subscriptions) {
    const endpoint = typeof subscription?.endpoint === 'string' ? subscription.endpoint.trim() : '';
    if (!endpoint || seen.has(endpoint)) continue;
    seen.add(endpoint);
    unique.push(subscription);
  }
  return unique;
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

function countSubscriptions(subscriptionsByUser) {
  let count = 0;

  for (const subscriptions of subscriptionsByUser.values()) {
    count += subscriptions.length;
  }

  return count;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
