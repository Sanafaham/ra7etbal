/**
 * POST /api/send-push-for-task
 *
 * QStash target endpoint. Called by QStash at the reminder's exact due_at time.
 *
 * Flow:
 *   1. Verify the QStash signature (prevents spoofed calls)
 *   2. Parse taskId from the request body
 *   3. Load the task — check it is still pending, unarchived, and unsent
 *   4. Load the user's enabled push subscriptions
 *   5. Send push via web-push
 *   6. Stamp last_push_sent_at (prevents duplicate sends from pg_cron safety net)
 *
 * Returns 200 for every outcome that should NOT be retried by QStash
 * (already sent, task done, no subscriptions).
 * Returns 500 only for transient errors QStash should retry.
 */

import webpush from 'web-push';
import { Receiver } from '@upstash/qstash';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── 1. Verify QStash signature ──────────────────────────────────────────
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentKey || !nextKey) {
    return res.status(500).json({ success: false, error: 'QStash signing keys not configured.' });
  }

  const receiver = new Receiver({ currentSigningKey: currentKey, nextSigningKey: nextKey });

  // Build the raw body string for signature verification
  const rawBody = JSON.stringify(req.body ?? {});

  try {
    await receiver.verify({
      signature: req.headers['upstash-signature'] ?? '',
      body: rawBody,
    });
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid QStash signature.' });
  }

  // ── 2. Parse taskId ─────────────────────────────────────────────────────
  const taskId = req.body?.taskId;
  console.log(`[send-push-for-task] invoked by QStash, taskId=${taskId}`);
  if (!taskId) {
    // Malformed message — return 200 so QStash doesn't retry indefinitely
    return res.status(200).json({ success: false, skipped: true, reason: 'Missing taskId.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ success: false, error: 'Server configuration error.' });
  }

  // ── 3. Load and validate the task ───────────────────────────────────────
  const taskRes = await fetch(
    `${supabaseUrl}/rest/v1/tasks` +
    `?select=id,user_id,description,status,type,due_at,last_push_sent_at,archived_at` +
    `&id=eq.${encodeURIComponent(taskId)}&limit=1`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );
  const tasks = await taskRes.json().catch(() => null);
  const task = Array.isArray(tasks) ? tasks[0] : null;

  if (!task) {
    console.log(`[send-push-for-task] taskId=${taskId} NOT FOUND — skipping`);
    return res.status(200).json({ success: false, skipped: true, reason: 'Task not found.' });
  }
  console.log(`[send-push-for-task] task loaded — userId=${task.user_id} status=${task.status} archived=${!!task.archived_at} last_push_sent_at=${task.last_push_sent_at}`);
  if (task.status !== 'pending') {
    console.log(`[send-push-for-task] skipping — status=${task.status}`);
    return res.status(200).json({ success: false, skipped: true, reason: `Task status is ${task.status}.` });
  }
  if (task.archived_at) {
    console.log(`[send-push-for-task] skipping — task is archived`);
    return res.status(200).json({ success: false, skipped: true, reason: 'Task is archived.' });
  }
  if (task.last_push_sent_at) {
    console.log(`[send-push-for-task] skipping — already sent at ${task.last_push_sent_at}`);
    return res.status(200).json({ success: false, skipped: true, reason: 'Push already sent.', sentAt: task.last_push_sent_at });
  }

  // ── 4. Load push subscriptions ──────────────────────────────────────────
  const subsRes = await fetch(
    `${supabaseUrl}/rest/v1/push_subscriptions` +
    `?select=id,endpoint,p256dh,auth` +
    `&user_id=eq.${encodeURIComponent(task.user_id)}` +
    `&enabled=eq.true`,
    { headers: supabaseHeaders(serviceRoleKey) },
  );
  const subscriptions = await subsRes.json().catch(() => []);

  console.log(`[send-push-for-task] userId=${task.user_id} subscriptions found=${Array.isArray(subscriptions) ? subscriptions.length : 0}`);
  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    console.log(`[send-push-for-task] skipping — no enabled push subscriptions for userId=${task.user_id}`);
    return res.status(200).json({ success: false, skipped: true, reason: 'No enabled push subscriptions.' });
  }

  // ── 5. Send push ────────────────────────────────────────────────────────
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;

  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return res.status(500).json({ success: false, error: 'VAPID keys not configured.' });
  }

  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (err) {
    return res.status(500).json({ success: false, error: `VAPID init failed: ${getErrorMessage(err)}` });
  }

  const payload = JSON.stringify({
    title: 'Ra7etBal reminder',
    body: `${task.description} is due now.`,
  });

  let sent = 0;
  let failed = 0;
  const errors = [];
  const perSubscription = [];

  for (const sub of subscriptions) {
    const endpointTail = sub.endpoint ? sub.endpoint.slice(-40) : '(missing)';
    console.log(`[send-push-for-task] sending to sub=${sub.id} endpoint=...${endpointTail}`);
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
      );
      sent += 1;
      console.log(`[send-push-for-task] ✓ sent to sub=${sub.id}`);
      perSubscription.push({ id: sub.id, endpointTail, result: 'sent' });
    } catch (err) {
      failed += 1;
      console.error(`[send-push-for-task] ✗ FAILED sub=${sub.id} statusCode=${err?.statusCode} message=${getErrorMessage(err)} body=${err?.body ?? null}`);
      perSubscription.push({
        id: sub.id,
        endpointTail,
        result: 'failed',
        statusCode: err?.statusCode ?? null,
        message: getErrorMessage(err),
        body: err?.body ?? null,
      });
      errors.push(`sub=${sub.id} status=${err?.statusCode} msg=${getErrorMessage(err)}`);
    }
  }

  // ── 6. Stamp last_push_sent_at if at least one send succeeded ───────────
  let markedSent = false;
  let markError = null;

  console.log(`[send-push-for-task] result: sent=${sent} failed=${failed} — ${sent > 0 ? 'writing last_push_sent_at' : 'no successful sends, skipping stamp'}`);
  if (sent > 0) {
    const sentAt = new Date().toISOString();
    console.log(`[send-push-for-task] stamping last_push_sent_at=${sentAt} on taskId=${taskId}`);
    const patchRes = await fetch(
      `${supabaseUrl}/rest/v1/tasks` +
      `?id=eq.${encodeURIComponent(taskId)}` +
      `&last_push_sent_at=is.null`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders(serviceRoleKey), Prefer: 'return=minimal' },
        body: JSON.stringify({ last_push_sent_at: sentAt }),
      },
    );
    if (patchRes.ok) {
      markedSent = true;
      console.log(`[send-push-for-task] ✓ last_push_sent_at stamped OK`);
    } else {
      const patchData = await patchRes.json().catch(() => null);
      markError = patchData?.message || `PATCH failed (${patchRes.status})`;
      console.error(`[send-push-for-task] ✗ last_push_sent_at stamp FAILED: ${markError}`);
    }
  }

  console.log(`[send-push-for-task] done — success=${sent > 0} sent=${sent} failed=${failed} markedSent=${markedSent}`);
  return res.status(200).json({
    success: sent > 0,
    taskId,
    sent,
    failed,
    markedSent,
    markError,
    errors,
    debug: perSubscription,
  });
}

function supabaseHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  };
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
