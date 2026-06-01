import webpush from "npm:web-push@3.6.7";

const MAX_TASKS_PER_RUN = 50;
const REMINDER_TIME_ZONE = "Europe/Istanbul";

interface SupabaseConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
}

interface PushConfig {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

interface DueReminderTask {
  id: string;
  user_id: string;
  description: string;
  due_at: string;
}

interface PushSubscriptionRow {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration_time: string | null;
}

Deno.serve(async (request) => {
  if (request.method !== "GET" && request.method !== "POST") {
    return jsonResponse({ success: false, error: "Method not allowed" }, 405);
  }

  if (!isAuthorized(request)) {
    return jsonResponse({ success: false, error: "Unauthorized" }, 401);
  }

  const supabaseConfig = getSupabaseConfig();
  const vapidKeysLoaded = hasVapidKeys();
  if (!supabaseConfig.ok) {
    return jsonResponse({
      success: false,
      error: "Reminder push is not configured.",
      missing: supabaseConfig.missing,
      remindersFound: 0,
      subscriptionsFound: 0,
      vapidKeysLoaded,
      webPushInitialized: false,
      pushSuccessCount: 0,
      pushFailureCount: 0,
      errors: [`Missing config: ${supabaseConfig.missing.join(", ")}`],
    }, 500);
  }

  const runStartedAt = new Date().toISOString();

  try {
    const tasks = await fetchDueReminderTasks(supabaseConfig.values, runStartedAt);
    if (tasks.length === 0) {
      return jsonResponse({
        success: true,
        remindersFound: 0,
        subscriptionsFound: 0,
        vapidKeysLoaded,
        webPushInitialized: false,
        pushSuccessCount: 0,
        pushFailureCount: 0,
        skipped: 0,
        markedSent: 0,
        errors: [],
      });
    }

    const subscriptionsByUser = await fetchSubscriptionsByUser(supabaseConfig.values, tasks);
    const subscriptionsFound = countSubscriptions(subscriptionsByUser);
    if (subscriptionsFound === 0) {
      return jsonResponse({
        success: true,
        remindersFound: tasks.length,
        subscriptionsFound,
        vapidKeysLoaded,
        webPushInitialized: false,
        pushSuccessCount: 0,
        pushFailureCount: 0,
        skipped: tasks.length,
        markedSent: 0,
        errors: [],
      });
    }

    const pushConfig = getPushConfig();
    if (!pushConfig.ok) {
      return jsonResponse({
        success: false,
        error: "Reminder push is not configured.",
        missing: pushConfig.missing,
        remindersFound: tasks.length,
        subscriptionsFound,
        vapidKeysLoaded,
        webPushInitialized: false,
        pushSuccessCount: 0,
        pushFailureCount: 0,
        errors: [`Missing config: ${pushConfig.missing.join(", ")}`],
      }, 500);
    }

    let webPushInitialized = false;
    try {
      webpush.setVapidDetails(
        pushConfig.values.vapidSubject,
        pushConfig.values.vapidPublicKey,
        pushConfig.values.vapidPrivateKey,
      );
      webPushInitialized = true;
    } catch (error) {
      return jsonResponse({
        success: false,
        remindersFound: tasks.length,
        subscriptionsFound,
        vapidKeysLoaded,
        webPushInitialized,
        pushSuccessCount: 0,
        pushFailureCount: 0,
        errors: [getErrorMessage(error)],
      }, 500);
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let markedSent = 0;
    const errors: string[] = [];

    for (const task of tasks) {
      const subscriptions = subscriptionsByUser.get(task.user_id) ?? [];
      if (subscriptions.length === 0) {
        skipped += 1;
        continue;
      }

      const result = await sendTaskReminder(task, subscriptions);
      sent += result.sent;
      failed += result.failed;
      errors.push(...result.errors);

      if (result.sent > 0) {
        const didMarkSent = await markTaskPushSent(supabaseConfig.values, task.id, runStartedAt);
        if (didMarkSent) {
          markedSent += 1;
        } else {
          skipped += 1;
        }
      } else {
        skipped += 1;
      }
    }

    return jsonResponse({
      success: true,
      remindersFound: tasks.length,
      subscriptionsFound,
      vapidKeysLoaded,
      webPushInitialized,
      pushSuccessCount: sent,
      pushFailureCount: failed,
      skipped,
      markedSent,
      errors,
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      remindersFound: 0,
      subscriptionsFound: 0,
      vapidKeysLoaded,
      webPushInitialized: false,
      pushSuccessCount: 0,
      pushFailureCount: 0,
      errors: [getErrorMessage(error)],
    }, 500);
  }
});

function isAuthorized(request: Request) {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  const [scheme, token] = authorization.trim().split(/\s+/, 2);
  return scheme.toLowerCase() === "bearer" && token === secret;
}

function getSupabaseConfig() {
  const values = {
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    serviceRoleKey: getSupabaseSecretKey(),
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return missing.length === 0
    ? { ok: true as const, values: values as SupabaseConfig }
    : { ok: false as const, missing };
}

function getPushConfig() {
  const values = {
    vapidPublicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? Deno.env.get("VITE_VAPID_PUBLIC_KEY"),
    vapidPrivateKey: Deno.env.get("VAPID_PRIVATE_KEY"),
    vapidSubject: Deno.env.get("VAPID_SUBJECT"),
  };
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  return missing.length === 0
    ? { ok: true as const, values: values as PushConfig }
    : { ok: false as const, missing };
}

function getSupabaseSecretKey() {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as Record<string, unknown>;
      if (typeof parsed.default === "string" && parsed.default.length > 0) {
        return parsed.default;
      }
    } catch {
      // Fall back to the legacy service role key below.
    }
  }

  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
}

function hasVapidKeys() {
  return Boolean(
    (Deno.env.get("VAPID_PUBLIC_KEY") ?? Deno.env.get("VITE_VAPID_PUBLIC_KEY")) &&
      Deno.env.get("VAPID_PRIVATE_KEY") &&
      Deno.env.get("VAPID_SUBJECT"),
  );
}

async function fetchDueReminderTasks(config: SupabaseConfig, nowIso: string) {
  const url =
    `${config.supabaseUrl}/rest/v1/tasks` +
    "?select=id,user_id,description,due_at" +
    "&type=eq.reminder" +
    "&status=eq.pending" +
    "&archived_at=is.null" +
    "&last_push_sent_at=is.null" +
    `&due_at=lte.${encodeURIComponent(nowIso)}` +
    "&order=due_at.asc" +
    `&limit=${MAX_TASKS_PER_RUN}`;

  const response = await fetch(url, {
    headers: supabaseHeaders(config),
  });
  const data = await readJson(response);

  if (!response.ok) {
    throw new Error(getSupabaseErrorMessage(data, "Could not load due reminder tasks."));
  }

  return Array.isArray(data) ? data as DueReminderTask[] : [];
}

async function fetchSubscriptionsByUser(config: SupabaseConfig, tasks: DueReminderTask[]) {
  const userIds = [...new Set(tasks.map((task) => task.user_id).filter(Boolean))];
  const subscriptionsByUser = new Map<string, PushSubscriptionRow[]>();

  if (userIds.length === 0) return subscriptionsByUser;

  const url =
    `${config.supabaseUrl}/rest/v1/push_subscriptions` +
    "?select=id,user_id,endpoint,p256dh,auth,expiration_time" +
    "&enabled=eq.true" +
    `&user_id=in.(${userIds.join(",")})`;

  const response = await fetch(url, {
    headers: supabaseHeaders(config),
  });
  const data = await readJson(response);

  if (!response.ok) {
    throw new Error(getSupabaseErrorMessage(data, "Could not load push subscriptions."));
  }

  for (const subscription of Array.isArray(data) ? data as PushSubscriptionRow[] : []) {
    const list = subscriptionsByUser.get(subscription.user_id) ?? [];
    list.push(subscription);
    subscriptionsByUser.set(subscription.user_id, list);
  }

  return subscriptionsByUser;
}

async function sendTaskReminder(
  task: DueReminderTask,
  subscriptions: PushSubscriptionRow[],
) {
  const payload = JSON.stringify({
    title: "Ra7etBal reminder",
    body: `Reminder: ${cleanReminderTitle(task.description)}\nDue: ${formatDueTime(task.due_at)}`,
  });

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

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
    } catch (error) {
      failed += 1;
      errors.push(getErrorMessage(error));
    }
  }

  return { sent, failed, errors };
}

function cleanReminderTitle(value: string) {
  const cleaned = value
    .trim()
    .replace(/^remind me to\s+/iu, "")
    .replace(/^reminder:\s*/iu, "")
    .replace(/[.!?؟،,;:]+$/u, "")
    .trim();

  return cleaned || "Reminder";
}

function formatDueTime(value: string) {
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return "now";

  const now = new Date();
  const time = due.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: REMINDER_TIME_ZONE,
  });

  if (isSameReminderDay(due, now)) {
    return `Today at ${time}`;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (isSameReminderDay(due, tomorrow)) {
    return `Tomorrow at ${time}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameReminderDay(due, yesterday)) {
    return `Yesterday at ${time}`;
  }

  return `${due.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: REMINDER_TIME_ZONE,
  })} at ${time}`;
}

function isSameReminderDay(a: Date, b: Date) {
  return formatReminderDay(a) === formatReminderDay(b);
}

function formatReminderDay(date: Date) {
  return date.toLocaleDateString("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: REMINDER_TIME_ZONE,
  });
}

async function markTaskPushSent(config: SupabaseConfig, taskId: string, sentAt: string) {
  const url =
    `${config.supabaseUrl}/rest/v1/tasks` +
    `?id=eq.${encodeURIComponent(taskId)}` +
    "&last_push_sent_at=is.null" +
    "&select=id";

  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      ...supabaseHeaders(config),
      Prefer: "return=representation",
    },
    body: JSON.stringify({ last_push_sent_at: sentAt }),
  });
  const data = await readJson(response);

  if (!response.ok) {
    throw new Error(getSupabaseErrorMessage(data, "Could not mark reminder push as sent."));
  }

  return Array.isArray(data) && data.length > 0;
}

function supabaseHeaders(config: SupabaseConfig) {
  return {
    apikey: config.serviceRoleKey,
    Authorization: `Bearer ${config.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

async function readJson(response: Response) {
  return response.json().catch(() => null);
}

function countSubscriptions(subscriptionsByUser: Map<string, PushSubscriptionRow[]>) {
  let count = 0;

  for (const subscriptions of subscriptionsByUser.values()) {
    count += subscriptions.length;
  }

  return count;
}

function getSupabaseErrorMessage(data: unknown, fallback: string) {
  if (
    data &&
    typeof data === "object" &&
    "message" in data &&
    typeof data.message === "string"
  ) {
    return data.message;
  }

  return fallback;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
