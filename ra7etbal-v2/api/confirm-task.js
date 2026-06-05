/**
 * POST /api/confirm-task
 *
 * Marks a delegated task as done (called from the recipient-facing /confirm
 * page). After a successful update, sends a push notification to the owner
 * so they know immediately without a WhatsApp message.
 *
 * Push pattern is identical to send-push-for-task.js and
 * send-due-reminder-pushes.js — same table, same VAPID keys.
 */

import webpush from 'web-push';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { taskId, confirmedBy } = req.body;

  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const headers = {
    'apikey': serviceKey,
    'Authorization': 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  try {
    // ── 1. Fetch the task ──────────────────────────────────────────────────
    // Include user_id and assigned_to so we can look up push subscriptions
    // and build a meaningful notification body.
    const fetchRes = await fetch(
      supabaseUrl + '/rest/v1/tasks' +
        '?id=eq.' + encodeURIComponent(taskId) +
        '&select=id,user_id,status,description,assigned_to',
      { headers },
    );

    const tasks = await fetchRes.json();

    if (!fetchRes.ok || !tasks || tasks.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = tasks[0];

    // Already done — idempotent response, no push (would be a duplicate).
    if (task.status === 'done') {
      return res.status(200).json({ already_done: true, description: task.description });
    }

    const now = new Date().toISOString();

    // ── 2. Mark task done ──────────────────────────────────────────────────
    const updateRes = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId),
      {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          status: 'done',
          confirmed_at: now,
          confirmed_by: confirmedBy || null,
        }),
      },
    );

    if (!updateRes.ok) {
      return res.status(500).json({ error: 'Could not confirm task. Please try again.' });
    }

    // ── 3. Insert confirmation record ──────────────────────────────────────
    await fetch(
      supabaseUrl + '/rest/v1/confirmations',
      {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          task_id: taskId,
          confirmed_at: now,
          confirmed_by: confirmedBy || null,
          source: 'confirmation_link',
        }),
      },
    ).catch(() => { /* non-fatal */ });

    // ── 4. Send push notification to the owner ─────────────────────────────
    // Fire-and-forget — push failure does NOT fail the confirmation.
    sendOwnerPush({
      supabaseUrl,
      serviceKey,
      userId: task.user_id,
      description: task.description,
      assignedTo: task.assigned_to,
    }).catch((err) => {
      console.error('[confirm-task] owner push failed (non-fatal):', err?.message || err);
    });

    return res.status(200).json({ success: true, description: task.description });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ---------------------------------------------------------------------------
// Push helper
// ---------------------------------------------------------------------------

async function sendOwnerPush({ supabaseUrl, serviceKey, userId, description, assignedTo }) {
  if (!userId) return;

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;

  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    console.warn('[confirm-task] VAPID keys not configured — owner push skipped');
    return;
  }

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  // Load the owner's enabled push subscriptions.
  const subsRes = await fetch(
    supabaseUrl + '/rest/v1/push_subscriptions' +
      '?user_id=eq.' + encodeURIComponent(userId) +
      '&enabled=eq.true' +
      '&select=id,endpoint,p256dh,auth',
    { headers },
  );
  const subscriptions = await subsRes.json().catch(() => []);

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    console.log('[confirm-task] no enabled push subscriptions for owner — skipping push');
    return;
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  // "Grace confirmed: Pick up the car" — or "Task confirmed: ..." if no name.
  const assignee = (assignedTo || '').trim();
  const notificationBody = assignee
    ? `${assignee} confirmed: ${description}`
    : `Task confirmed: ${description}`;

  const payload = JSON.stringify({
    title: 'Ra7etBal',
    body: notificationBody,
  });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { urgency: 'high', TTL: 300 },
      );
      console.log(`[confirm-task] owner push sent to sub=${sub.id}`);
    } catch (err) {
      const statusCode = err?.statusCode ?? null;
      console.error(`[confirm-task] owner push failed sub=${sub.id} status=${statusCode}:`, err?.message);

      // Clean up permanently invalid subscriptions.
      if (statusCode === 410 || statusCode === 404) {
        await fetch(
          supabaseUrl + '/rest/v1/push_subscriptions?id=eq.' + encodeURIComponent(sub.id),
          { method: 'DELETE', headers },
        ).catch(() => {});
      }
    }
  }
}
