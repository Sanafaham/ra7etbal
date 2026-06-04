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
 */

const QSTASH_BASE = 'https://qstash.upstash.io/v2';

export default async function handler(req, res) {
  const requestId = Math.random().toString(36).slice(2, 8);
  console.log(`[qstash-reminder][${requestId}] ${req.method} received`);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── 1. Env var check ────────────────────────────────────────────────────────
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const qstashToken = process.env.QSTASH_TOKEN;
  let appBaseUrl = (process.env.APP_BASE_URL || 'https://ra7etbal-v2.vercel.app').trim();
  // Ensure the URL has a scheme — QStash rejects destinations without https://
  if (appBaseUrl && !appBaseUrl.startsWith('http://') && !appBaseUrl.startsWith('https://')) {
    appBaseUrl = `https://${appBaseUrl}`;
  }
  // Strip any trailing slash for clean URL construction
  appBaseUrl = appBaseUrl.replace(/\/$/, '');

  const missingVars = [];
  if (!supabaseUrl) missingVars.push('SUPABASE_URL');
  if (!serviceRoleKey) missingVars.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!qstashToken) missingVars.push('QSTASH_TOKEN');

  if (missingVars.length > 0) {
    console.error(`[qstash-reminder][${requestId}] MISSING ENV VARS: ${missingVars.join(', ')}`);
    return res.status(500).json({
      success: false,
      error: `Server configuration error: missing ${missingVars.join(', ')}`,
    });
  }

  console.log(`[qstash-reminder][${requestId}] env vars OK, appBaseUrl=${appBaseUrl}`);

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
  const { action, taskId, dueAt } = body;

  console.log(`[qstash-reminder][${requestId}] action=${action} taskId=${taskId} dueAt=${dueAt}`);

  if (!action || !taskId) {
    return res.status(400).json({ success: false, error: 'action and taskId are required.' });
  }
  if ((action === 'schedule' || action === 'reschedule') && !dueAt) {
    return res.status(400).json({ success: false, error: 'dueAt is required for schedule/reschedule.' });
  }

  // ── 4. Verify task ownership ────────────────────────────────────────────────
  const taskRes = await fetch(
    `${supabaseUrl}/rest/v1/tasks?select=id,user_id,qstash_message_id&id=eq.${encodeURIComponent(taskId)}&limit=1`,
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

  console.log(`[qstash-reminder][${requestId}] task verified, existing qstash_message_id=${task.qstash_message_id}`);

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

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'QStash operation failed.';
    console.error(`[qstash-reminder][${requestId}] ERROR action=${action} taskId=${taskId}: ${msg}`);
    return res.status(500).json({ success: false, error: msg });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function scheduleMessage(appBaseUrl, taskId, dueAt, qstashToken, requestId) {
  const dueMs = new Date(dueAt).getTime();
  if (Number.isNaN(dueMs)) throw new Error(`Invalid dueAt value: ${dueAt}`);

  const notBeforeUnix = Math.floor(dueMs / 1000);

  const callbackUrl = `${appBaseUrl}/api/send-push-for-task`;
  console.log(`[qstash-reminder][${requestId}] callback URL = ${callbackUrl}`);
  console.log(`[qstash-reminder][${requestId}] publishing to QStash, notBefore=${notBeforeUnix} (${new Date(dueMs).toISOString()})`);

  const destination = encodeURIComponent(callbackUrl);
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
  console.log(`[qstash-reminder][${requestId}] QStash publish response: status=${response.status} body=${JSON.stringify(data)}`);

  if (!response.ok) {
    throw new Error(data?.error || `QStash schedule failed (${response.status})`);
  }

  return data?.messageId ?? data?.message_id ?? null;
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
      body: JSON.stringify({ qstash_message_id: messageId }),
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

function supabaseHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}
