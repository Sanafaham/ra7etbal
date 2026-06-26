/**
 * /api/task-confirm — unified confirm-task handler
 *
 * Merges get-confirm-task.js (GET) and confirm-task.js (POST) to stay
 * within the Vercel Hobby 12-serverless-function limit.
 *
 * GET  /api/task-confirm?taskId=<id>
 *   Returns task data + signed image URLs + signed upload URL for proof photo.
 *   Called by the public /confirm page (no auth session required).
 *
 * POST /api/task-confirm  { taskId, confirmedBy?, proofImagePath? }
 *   Quality Intelligence V1 — when a proof photo is submitted for a
 *   delegated task, Carson reviews it (downloadImageAsBase64 +
 *   runQualityReview from _quality-review.js) before deciding what happens:
 *     - approved: falls through to the original behavior — mark done,
 *       insert a confirmation record, push the owner.
 *     - correction_required: task stays pending; a short WhatsApp message
 *       is sent to the assignee via the existing send-whatsapp-task route
 *       (sendMode: "direct_message", no new template).
 *     - uncertain: task stays pending; the owner gets pushed to review
 *       manually instead of a "confirmed" notification.
 *     - fraud_suspected: task stays pending; the photo itself looks like it
 *       isn't genuine proof (screenshot, reused reference image, etc). The
 *       owner gets pushed to review — the assignee never receives an
 *       automatic correction message for this outcome; only the owner can
 *       decide to follow up.
 *   No proof photo, or a task with no assignee (assigned_to null) — review
 *   is skipped entirely and behavior is unchanged from before this stage
 *   existed.
 */

import webpush from 'web-push';
import { downloadImageAsBase64, runQualityReview } from './_quality-review.js';

export default async function handler(req, res) {
  if (req.method === 'GET') return handleGet(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
}

// ── GET: load task for the Confirm page ──────────────────────────────────────

async function handleGet(req, res) {
  const { taskId } = req.query;

  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  try {
    const response = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + taskId +
        '&select=id,user_id,description,assigned_to,status,confirmed_at,image_path,proof_image_path,attachment_count',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
        },
      },
    );

    const data = await response.json();

    if (!response.ok || !data || data.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = data[0];
    const ownerPhone = await findOwnerPhone({ supabaseUrl, serviceKey, userId: task.user_id });

    let imageUrl = null;
    if (task.image_path) {
      imageUrl = await getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: task.image_path });
    }

    let proofImageUrl = null;
    if (task.proof_image_path) {
      proofImageUrl = await getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: task.proof_image_path });
    }

    // Load task_attachments for multi-photo tasks, sorted by sort_order.
    let attachmentUrls = [];
    if (task.attachment_count > 0) {
      const attachRes = await fetch(
        supabaseUrl + '/rest/v1/task_attachments?task_id=eq.' + encodeURIComponent(task.id) +
          '&order=sort_order.asc&select=storage_path',
        {
          headers: {
            apikey: serviceKey,
            Authorization: 'Bearer ' + serviceKey,
            'Content-Type': 'application/json',
          },
        },
      );
      if (attachRes.ok) {
        const attachRows = await attachRes.json().catch(() => []);
        attachmentUrls = await Promise.all(
          (Array.isArray(attachRows) ? attachRows : []).map((row) =>
            getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: row.storage_path }),
          ),
        );
        attachmentUrls = attachmentUrls.filter(Boolean);
      }
    }

    let proofUploadUrl = null;
    let proofUploadPath = null;
    if (task.status !== 'done' && task.user_id) {
      const uploadResult = await createSignedUploadUrl({
        supabaseUrl,
        serviceKey,
        userId: task.user_id,
        taskId: task.id,
      });
      proofUploadUrl = uploadResult?.uploadUrl ?? null;
      proofUploadPath = uploadResult?.storagePath ?? null;
    }

    return res.status(200).json({
      id: task.id,
      description: task.description,
      assignedTo: task.assigned_to,
      status: task.status,
      confirmedAt: task.confirmed_at,
      ownerPhone,
      imageUrl,
      attachmentUrls,
      proofImageUrl,
      proofUploadUrl,
      proofUploadPath,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── POST: confirm the task ────────────────────────────────────────────────────

async function handlePost(req, res) {
  const { taskId, confirmedBy, proofImagePath } = req.body;

  if (!taskId) {
    return res.status(400).json({ error: 'Task ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  try {
    // 1. Fetch the task
    const fetchRes = await fetch(
      supabaseUrl + '/rest/v1/tasks' +
        '?id=eq.' + encodeURIComponent(taskId) +
        '&select=id,user_id,status,description,assigned_to,image_path',
      { headers },
    );

    const tasks = await fetchRes.json();

    if (!fetchRes.ok || !tasks || tasks.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = tasks[0];

    // Idempotent — already done
    if (task.status === 'done') {
      return res.status(200).json({ already_done: true, description: task.description });
    }

    const now = new Date().toISOString();

    // Quality Intelligence V1 — only applies to delegated tasks with a
    // freshly submitted proof photo. No proof / no assignee → unchanged.
    const needsReview = !!proofImagePath && !!task.assigned_to;
    let review = null;

    if (needsReview) {
      const apiKey = process.env.ANTHROPIC_API_KEY;

      const [delegationMessage, referenceImageBase64, proofImageBase64] = await Promise.all([
        fetchDelegationMessageContent({ supabaseUrl, serviceKey, taskId }),
        downloadImageAsBase64({ supabaseUrl, serviceKey, imagePath: task.image_path }),
        downloadImageAsBase64({ supabaseUrl, serviceKey, imagePath: proofImagePath }),
      ]);

      review = await runQualityReview({
        apiKey,
        taskDescription: task.description,
        delegationMessage,
        referenceImageBase64,
        proofImageBase64,
      });
    }

    if (review && review.status !== 'approved') {
      // CORRECTION_REQUIRED, UNCERTAIN, or FRAUD_SUSPECTED — task stays
      // open. Save the submitted photo and the review outcome; do not mark
      // done, do not insert a confirmation record.
      const patchRes = await fetch(
        supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId),
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            proof_image_path: proofImagePath,
            quality_review_status: review.status,
            quality_review_note: review.note,
            quality_reviewed_at: now,
          }),
        },
      );

      if (!patchRes.ok) {
        return res.status(500).json({ error: 'Could not save the review. Please try again.' });
      }

      let correctionDelivered = null;
      if (review.status === 'correction_required') {
        correctionDelivered = await sendCorrectionWhatsApp({
          supabaseUrl,
          serviceKey,
          userId: task.user_id,
          taskId,
          assignedTo: task.assigned_to,
          correctionMessage: review.note,
        }).catch((err) => {
          console.error('[task-confirm] correction WhatsApp send failed (non-fatal):', err?.message || err);
          return false;
        });
      } else {
        // UNCERTAIN or FRAUD_SUSPECTED — owner-only notification, never an
        // automatic message to the assignee. For fraud_suspected this is
        // deliberate: the owner decides whether and how to follow up with
        // the assignee, Carson does not accuse anyone automatically.
        await sendOwnerPush({
          supabaseUrl,
          serviceKey,
          userId: task.user_id,
          description: task.description,
          assignedTo: task.assigned_to,
          variant: review.status,
        }).catch((err) =>
          console.error(`[task-confirm] ${review.status}-review owner push failed (non-fatal):`, err?.message || err),
        );
      }

      return res.status(200).json({
        success: true,
        outcome: review.status,
        description: task.description,
        // Only meaningful for outcome "correction_required" — whether the
        // WhatsApp message describing the correction actually went out.
        // null for "uncertain" / "fraud_suspected" (no WhatsApp send is
        // attempted to the assignee for those outcomes).
        correctionDelivered,
      });
    }

    // 2. Mark task done — original behavior, now also recording an
    // APPROVED review outcome when one was run.
    const updateRes = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId),
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'done',
          confirmed_at: now,
          ...(proofImagePath ? { proof_image_path: proofImagePath } : {}),
          ...(review
            ? { quality_review_status: 'approved', quality_review_note: review.note, quality_reviewed_at: now }
            : {}),
        }),
      },
    );

    if (!updateRes.ok) {
      return res.status(500).json({ error: 'Could not confirm task. Please try again.' });
    }

    // 3. Insert confirmation record (non-fatal)
    await fetch(supabaseUrl + '/rest/v1/confirmations', {
      method: 'POST',
      headers: { ...headers, Prefer: 'return=minimal' },
      body: JSON.stringify({
        task_id: taskId,
        confirmed_at: now,
        confirmed_by: confirmedBy || null,
        source: 'confirmation_link',
      }),
    }).catch(() => {});

    // 4. Push notification to owner (non-fatal)
    try {
      await sendOwnerPush({
        supabaseUrl,
        serviceKey,
        userId: task.user_id,
        description: task.description,
        assignedTo: task.assigned_to,
      });
    } catch (err) {
      console.error('[task-confirm] owner push failed (non-fatal):', err?.message || err);
    }

    return res.status(200).json({ success: true, outcome: 'approved', description: task.description });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── Push helper ───────────────────────────────────────────────────────────────

async function sendOwnerPush({ supabaseUrl, serviceKey, userId, description, assignedTo, variant }) {
  if (!userId) return;

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;

  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    console.warn('[task-confirm] VAPID keys not configured — owner push skipped');
    return;
  }

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  const subsRes = await fetch(
    supabaseUrl + '/rest/v1/push_subscriptions' +
      '?user_id=eq.' + encodeURIComponent(userId) +
      '&enabled=eq.true' +
      '&select=id,endpoint,p256dh,auth',
    { headers },
  );
  const subscriptions = await subsRes.json().catch(() => []);

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    console.log('[task-confirm] no enabled push subscriptions for owner — skipping');
    return;
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const assignee = (assignedTo || '').trim();
  const notificationBody =
    variant === 'uncertain'
      ? `Carson is unsure about ${assignee ? `${assignee}'s` : 'the'} proof for: ${description}. Please check.`
      : variant === 'fraud_suspected'
        ? `Carson flagged ${assignee ? `${assignee}'s` : 'the'} proof for: ${description}. The photo doesn't look like genuine proof — please review.`
        : assignee
          ? `${assignee} confirmed: ${description}`
          : `Task confirmed: ${description}`;

  const payload = JSON.stringify({ title: 'Ra7etBal', body: notificationBody });

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { urgency: 'high', TTL: 300 },
      );
      console.log(`[task-confirm] owner push sent to sub=${sub.id}`);
    } catch (err) {
      const statusCode = err?.statusCode ?? null;
      console.error(`[task-confirm] owner push failed sub=${sub.id} status=${statusCode}:`, err?.message);
      if (statusCode === 410 || statusCode === 404) {
        await fetch(
          supabaseUrl + '/rest/v1/push_subscriptions?id=eq.' + encodeURIComponent(sub.id),
          { method: 'DELETE', headers },
        ).catch(() => {});
      }
    }
  }
}

// ── Quality Intelligence V1 helpers ───────────────────────────────────────────

/** Best-effort lookup of the companion delegation message for a task. */
async function fetchDelegationMessageContent({ supabaseUrl, serviceKey, taskId }) {
  try {
    const response = await fetch(
      supabaseUrl + '/rest/v1/messages?task_id=eq.' + encodeURIComponent(taskId) +
        '&select=content&limit=1',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
        },
      },
    );
    if (!response.ok) return null;
    const rows = await response.json();
    return Array.isArray(rows) && rows[0]?.content ? rows[0].content : null;
  } catch {
    return null;
  }
}

/**
 * Sends the correction message to the assignee via the existing
 * send-whatsapp-task route (sendMode: "direct_message") — same plain
 * template already used for direct messages. No new template, no new
 * Vercel function.
 *
 * Root cause of the original silent failure: send-whatsapp-task.js requires
 * a messageRecordId for any sendMode: "direct_message" send (it rejects with
 * 400 "Direct message requires a saved message record" otherwise), and
 * beginWhatsappDelivery cannot create a whatsapp_deliveries row without a
 * messageRecordId or taskId to resolve ownership from ("no trusted owner
 * context" — see _whatsapp-delivery.js resolveDeliveryContext). This
 * function previously called send-whatsapp-task with neither, so every
 * correction send 400'd before ever reaching Meta, and the failure was only
 * ever logged via the caller's non-fatal console.error. Fixed by inserting a
 * `messages` row first — the same pattern already used by
 * direct-message-fast-path.ts and the send_direct_whatsapp_message tool —
 * and passing both messageRecordId and taskId through.
 */
async function sendCorrectionWhatsApp({ supabaseUrl, serviceKey, userId, taskId, assignedTo, correctionMessage }) {
  if (!userId || !assignedTo || !correctionMessage) return false;

  const headers = {
    apikey: serviceKey,
    Authorization: 'Bearer ' + serviceKey,
    'Content-Type': 'application/json',
  };

  const response = await fetch(
    supabaseUrl + '/rest/v1/people?user_id=eq.' + encodeURIComponent(userId) +
      '&select=name,phone,whatsapp_opted_in',
    { headers },
  );
  if (!response.ok) return false;
  const people = await response.json().catch(() => []);
  if (!Array.isArray(people)) return false;

  const assignee = people.find(
    (person) => String(person.name || '').trim().toLowerCase() === assignedTo.trim().toLowerCase(),
  );
  if (!assignee?.phone || assignee.whatsapp_opted_in !== true) {
    console.warn('[task-confirm] correction message skipped — no phone or consent for', assignedTo);
    return false;
  }

  const appBaseUrl = process.env.APP_BASE_URL;
  if (!appBaseUrl) {
    console.warn('[task-confirm] APP_BASE_URL not configured — correction message skipped');
    return false;
  }

  // task_id on the `messages` row itself is fine and expected — it's the
  // separate top-level `taskId` request param below that send-whatsapp-task.js
  // explicitly rejects for direct messages (see root-cause note below).
  const messageRes = await fetch(supabaseUrl + '/rest/v1/messages', {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({
      user_id: userId,
      task_id: taskId || null,
      recipient: assignee.name,
      content: correctionMessage,
      confirmation_url: null,
    }),
  });
  if (!messageRes.ok) {
    console.error('[task-confirm] could not save correction message record — send aborted', messageRes.status);
    return false;
  }
  const savedMessages = await messageRes.json().catch(() => []);
  const messageRecordId = Array.isArray(savedMessages) ? savedMessages[0]?.id : null;
  if (!messageRecordId) {
    console.error('[task-confirm] correction message record had no id — send aborted');
    return false;
  }

  // Root cause of the previous failure: send-whatsapp-task.js explicitly
  // rejects any sendMode: "direct_message" request that also includes a
  // top-level taskId — "Direct messages cannot include a task." (400,
  // before any Meta call). Every other existing caller of direct_message
  // (direct-message-fast-path.ts, the send_direct_whatsapp_message tool)
  // passes taskId: null for exactly this reason; messageRecordId alone is
  // enough for beginWhatsappDelivery to resolve ownership and the task link,
  // since the messages row above already carries task_id.
  const sendRes = await fetch(`${appBaseUrl}/api/send-whatsapp-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: assignee.phone,
      messageText: correctionMessage,
      messageRecordId,
      taskId: null,
      sourceType: 'message',
      sendMode: 'direct_message',
      recipientName: assignee.name,
    }),
  });

  if (!sendRes.ok) {
    const errBody = await sendRes.text().catch(() => '');
    console.error('[task-confirm] correction WhatsApp send returned non-ok', sendRes.status, errBody.slice(0, 200));
    return false;
  }
  return true;
}

// ── Storage helpers (from get-confirm-task.js) ────────────────────────────────

async function findOwnerPhone({ supabaseUrl, serviceKey, userId }) {
  if (!userId) return null;

  const response = await fetch(
    supabaseUrl + '/rest/v1/people?user_id=eq.' +
      encodeURIComponent(userId) + '&select=name,role,phone',
    {
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!response.ok) return null;
  const people = await response.json();
  if (!Array.isArray(people)) return null;

  const owner = people.find((person) => {
    const name = String(person.name || '').trim().toLowerCase();
    const role = String(person.role || '').trim().toLowerCase();
    return (name === 'boss' || role === 'boss') && person.phone;
  });

  return owner ? owner.phone : null;
}

async function getSignedImageUrl({ supabaseUrl, serviceKey, imagePath }) {
  if (!imagePath) return null;

  const BUCKET = 'task-images';
  const objectPath = imagePath.startsWith(`${BUCKET}/`)
    ? imagePath.slice(`${BUCKET}/`.length)
    : imagePath;

  try {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/sign/${BUCKET}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (!data?.signedURL) return null;
    return `${supabaseUrl}/storage/v1${data.signedURL}`;
  } catch {
    return null;
  }
}

async function createSignedUploadUrl({ supabaseUrl, serviceKey, userId, taskId }) {
  if (!userId || !taskId) return null;

  const BUCKET = 'task-images';
  const objectPath = `${userId}/${taskId}/proof.jpg`;
  const storagePath = `${BUCKET}/${objectPath}`;

  try {
    const response = await fetch(
      `${supabaseUrl}/storage/v1/object/upload/sign/${BUCKET}/${objectPath}`,
      {
        method: 'POST',
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('[task-confirm] createSignedUploadUrl: Supabase returned non-ok', {
        status: response.status,
        body: errText.slice(0, 200),
      });
      return null;
    }
    const data = await response.json();
    if (!data?.url) {
      console.warn('[task-confirm] createSignedUploadUrl: no url in response', {
        keys: data ? Object.keys(data) : null,
        data: JSON.stringify(data).slice(0, 300),
      });
      return null;
    }
    const uploadUrl = `${supabaseUrl}/storage/v1${data.url}`;
    return { uploadUrl, storagePath };
  } catch {
    return null;
  }
}
