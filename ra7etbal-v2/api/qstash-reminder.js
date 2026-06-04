/**
 * POST /api/qstash-reminder
 *
 * Manages QStash delayed jobs for reminder push notifications.
 * Called from the browser after task mutations — never directly by QStash.
 *
 * Body: { action: 'schedule' | 'cancel' | 'reschedule', taskId, dueAt? }
 *
 * Auth: Supabase access token in Authorization: Bearer <token> header.
 *       Verified server-side; only the task owner may schedule/cancel.
 *
 * Actions:
 *   schedule   — publish a QStash message delayed until dueAt, store messageId
 *   cancel     — cancel the stored QStash message, clear qstash_message_id
 *   reschedule — cancel existing message (if any) then schedule a new one
 */

const QSTASH_BASE = 'https://qstash.upstash.io/v2';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── 1. Verify caller is a signed-in Supabase user ──────────────────────
  const authorization = req.headers.authorization || req.headers.Authorization || '';
  const userToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!userToken) {
    return res.status(401).json({ success: false, error: 'Missing authorization token.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const qstashToken = process.env.QSTASH_TOKEN;
  const appBaseUrl = process.env.APP_BASE_URL || 'https://ra7etbal-v2.vercel.app';

  if (!supabaseUrl || !serviceRoleKey || !qstashToken) {
    return res.status(500).json({ success: false, error: 'Server configuration error.' });
  }

  // Verify JWT and get userId
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${userToken}` },
  });
  if (!userRes.ok) {
    return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
  }
  const userData = await userRes.json().catch(() => null);
  const userId = userData?.id;
  if (!userId) {
    return res.status(401).json({ success: false, error: 'Could not resolve user.' });
  }

  // ── 2. Parse and validate body ──────────────────────────────────────────
  const body = req.body ?? {};
  const { action, taskId, dueAt } = body;

  if (!action || !taskId) {
    return res.status(400).json({ success: false, error: 'action and taskId are required.' });
  }
  if ((action === 'schedule' || action === 'reschedule') && !dueAt) {
    return res.status(400).json({ success: false, error: 'dueAt is required for schedule/reschedule.' });
  }

  // ── 3. Verify task ownership ────────────────────────────────────────────
  const taskRes = await fetch(
    `${supabaseUrl}/rest/v1/tasks?select=id,user_id,qstash_message_id&id=eq.${encodeURIComponent(taskId)}&limit=1`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );
  const tasks = await taskRes.json().catch(() => null);
  const task = Array.isArray(tasks) ? tasks[0] : null;

  if (!task) {
    return res.status(404).json({ success: false, error: 'Task not found.' });
  }
  if (task.user_id !== userId) {
    return res.status(403).json({ success: false, error: 'Not your task.' });
  }

  // ── 4. Execute action ───────────────────────────────────────────────────
  try {
    if (action === 'cancel') {
      await cancelMessage(task.qstash_message_id, qstashToken);
      await clearMessageId(supabaseUrl, serviceRoleKey, taskId);
      return res.status(200).json({ success: true, action: 'cancelled' });
    }

    if (action === 'schedule') {
      const messageId = await scheduleMessage(appBaseUrl, taskId, dueAt, qstashToken);
      await saveMessageId(supabaseUrl, serviceRoleKey, taskId, messageId);
      return res.status(200).json({ success: true, action: 'scheduled', messageId });
    }

    if (action === 'reschedule') {
      await cancelMessage(task.qstash_message_id, qstashToken);
      const messageId = await scheduleMessage(appBaseUrl, taskId, dueAt, qstashToken);
      await saveMessageId(supabaseUrl, serviceRoleKey, taskId, messageId);
      return res.status(200).json({ success: true, action: 'rescheduled', messageId });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err instanceof Error ? err.message : 'QStash operation failed.',
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function scheduleMessage(appBaseUrl, taskId, dueAt, qstashToken) {
  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(dueMs)) throw new Error(`Invalid dueAt value: ${dueAt}`);

  const notBeforeUnix = Math.floor(dueMs / 1000);
  const destination = encodeURIComponent(`${appBaseUrl}/api/send-push-for-task`);

  const response = await fetch(`${QSTASH_BASE}/publish/${destination}`, {
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

  if (!response.ok) {
    throw new Error(data?.error || `QStash schedule failed (${response.status})`);
  }

  return data?.messageId ?? data?.message_id ?? null;
}

async function cancelMessage(qstashMessageId, qstashToken) {
  if (!qstashMessageId) return; // nothing to cancel — no-op

  const response = await fetch(`${QSTASH_BASE}/messages/${qstashMessageId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${qstashToken}` },
  });

  // 404 means it was already delivered or expired — treat as success
  if (!response.ok && response.status !== 404) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `QStash cancel failed (${response.status})`);
  }
}

async function saveMessageId(supabaseUrl, serviceRoleKey, taskId, messageId) {
  const response = await fetch(
    `${supabaseUrl}/rest/v1/tasks?id=eq.${encodeURIComponent(taskId)}`,
    {
      method: 'PATCH',
      headers: { ...supabaseHeaders(serviceRoleKey), Prefer: 'return=minimal' },
      body: JSON.stringify({ qstash_message_id: messageId }),
    },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.message || 'Could not save QStash message ID.');
  }
}

async function clearMessageId(supabaseUrl, serviceRoleKey, taskId) {
  await saveMessageId(supabaseUrl, serviceRoleKey, taskId, null);
}

function supabaseHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}
