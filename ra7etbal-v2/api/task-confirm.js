/**
 * /api/task-confirm — unified confirm-task handler
 *
 * Merges get-confirm-task.js (GET) and confirm-task.js (POST) to stay
 * within the Vercel Hobby 12-serverless-function limit.
 *
 * GET  /api/task-confirm?taskId=<id>
 *   Returns task data + signed image URLs + up to 5 signed upload URLs for
 *   proof photos (Proof Photo V2). Called by the public /confirm page (no
 *   auth session required).
 *
 * POST /api/task-confirm  { taskId, confirmedBy?, proofImagePaths?: string[] }
 *   Quality Intelligence V1 — when 1-5 proof photos are submitted for a
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
 *   Photo delegations require proof before completion. Non-photo tasks, or a
 *   task with no assignee (assigned_to null), keep the original no-review
 *   completion behavior.
 */

import webpush from 'web-push';
import { downloadImageAsBase64, runQualityReview } from './_quality-review.js';

// Proof Photo V2 — up to 5 proof photos per task. No schema change: proof
// photos are stored in the existing task_attachments table (the same table
// reference photos use), discriminated by the previously-unused file_name
// column set to 'proof' (reference-photo rows never set file_name).
const MAX_PROOF_PHOTOS = 5;

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

    // Load task_attachments for multi-photo reference tasks, sorted by
    // sort_order. file_name=is.null excludes proof-photo rows (below) — a
    // defensive filter, since reference rows never set file_name anyway.
    let attachmentUrls = [];
    if (task.attachment_count > 0) {
      const attachRes = await fetch(
        supabaseUrl + '/rest/v1/task_attachments?task_id=eq.' + encodeURIComponent(task.id) +
          '&file_name=is.null&order=sort_order.asc&select=storage_path',
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

    // Load already-submitted proof photos (0-5), sorted by sort_order.
    let proofImageUrls = [];
    const proofAttachRes = await fetch(
      supabaseUrl + '/rest/v1/task_attachments?task_id=eq.' + encodeURIComponent(task.id) +
        '&file_name=eq.proof&order=sort_order.asc&select=storage_path',
      {
        headers: {
          apikey: serviceKey,
          Authorization: 'Bearer ' + serviceKey,
          'Content-Type': 'application/json',
        },
      },
    );
    if (proofAttachRes.ok) {
      const proofRows = await proofAttachRes.json().catch(() => []);
      proofImageUrls = await Promise.all(
        (Array.isArray(proofRows) ? proofRows : []).map((row) =>
          getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: row.storage_path }),
        ),
      );
      proofImageUrls = proofImageUrls.filter(Boolean);
    }
    // Legacy single-column fallback — a task confirmed before Proof Photo V2
    // only ever wrote tasks.proof_image_path, with no task_attachments row.
    if (proofImageUrls.length === 0 && task.proof_image_path) {
      const legacyUrl = await getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: task.proof_image_path });
      if (legacyUrl) proofImageUrls = [legacyUrl];
    }

    // Fresh signed upload URLs for up to 5 proof-photo slots. Each slot's
    // signed URL is created with x-upsert so resubmitting to the same index
    // (e.g. after a Quality Intelligence rejection) overwrites cleanly
    // instead of failing with "Upload failed (400)".
    let proofUploadSlots = [];
    if (task.status !== 'done' && task.user_id) {
      proofUploadSlots = await createSignedProofUploadUrls({
        supabaseUrl,
        serviceKey,
        userId: task.user_id,
        taskId: task.id,
        count: MAX_PROOF_PHOTOS,
      });
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
      proofImageUrls,
      proofUploadSlots,
      proofRequired: Boolean(task.assigned_to && (task.image_path || Number(task.attachment_count || 0) > 0)),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── POST: confirm the task ────────────────────────────────────────────────────

async function handlePost(req, res) {
  const { taskId, confirmedBy, proofImagePaths: rawProofImagePaths } = req.body;
  const proofImagePaths = (Array.isArray(rawProofImagePaths) ? rawProofImagePaths : [])
    .filter((p) => typeof p === 'string' && p.trim())
    .slice(0, MAX_PROOF_PHOTOS);

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
        '&select=id,user_id,status,description,assigned_to,image_path,attachment_count,quality_review_cycle_count',
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

    // Quality Intelligence V1 — photo delegations must include proof so the
    // review cannot be bypassed by tapping Mark done without uploading.
    const proofRequired = Boolean(task.assigned_to && (task.image_path || Number(task.attachment_count || 0) > 0));
    if (proofRequired && proofImagePaths.length === 0) {
      return res.status(400).json({
        error: 'Please attach a proof photo before marking this task done.',
      });
    }

    // Quality Intelligence V1 — only applies to delegated tasks with at
    // least one freshly submitted proof photo. No proof / no assignee →
    // unchanged.
    const needsReview = proofImagePaths.length > 0 && !!task.assigned_to;
    let review = null;

    if (needsReview) {
      const apiKey = process.env.ANTHROPIC_API_KEY;

      const [delegationMessage, referenceImageBase64, proofImagesBase64] = await Promise.all([
        fetchDelegationMessageContent({ supabaseUrl, serviceKey, taskId }),
        downloadImageAsBase64({ supabaseUrl, serviceKey, imagePath: task.image_path }),
        Promise.all(
          proofImagePaths.map((imagePath) => downloadImageAsBase64({ supabaseUrl, serviceKey, imagePath })),
        ),
      ]);

      review = await runQualityReview({
        apiKey,
        taskDescription: task.description,
        delegationMessage,
        referenceImageBase64,
        proofImagesBase64,
      });
    }

    if (review && review.status !== 'approved') {
      // CORRECTION_REQUIRED, UNCERTAIN, or FRAUD_SUSPECTED — task stays
      // open. Save the submitted photo and the review outcome; do not mark
      // done, do not insert a confirmation record.
      //
      // quality_review_cycle_count is incremented on every non-approved
      // outcome as a lifetime record of how many rounds this task needed.
      // It is never reset on approval.
      const cycleCount = (task.quality_review_cycle_count || 0) + 1;

      const patchRes = await fetch(
        supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId),
        {
          method: 'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body: JSON.stringify({
            // Primary/back-compat column — TaskCard, HistoryCard, and
            // ConfirmationNotices all read this single column for a thumbnail.
            proof_image_path: proofImagePaths[0] ?? null,
            quality_review_status: review.status,
            quality_review_note: review.note,
            quality_reviewed_at: now,
            quality_review_cycle_count: cycleCount,
          }),
        },
      );

      if (!patchRes.ok) {
        return res.status(500).json({ error: 'Could not save the review. Please try again.' });
      }

      // Persist the full submitted proof set (up to 5) for the confirmation
      // page to display and for the next review cycle to read back. Best-
      // effort: the review outcome above already saved successfully, so a
      // failure here only means extra proof photos beyond the primary one
      // won't show on reload — not a lost submission.
      await replaceProofAttachments({
        supabaseUrl,
        serviceKey,
        taskId,
        userId: task.user_id,
        proofImagePaths,
      }).catch((err) =>
        console.error('[task-confirm] replaceProofAttachments failed (non-fatal):', err?.message || err),
      );

      // Owner push only when manual owner review is required.
      // correction_required is sent directly to the assignee through the
      // existing direct-message WhatsApp path; uncertain and fraud_suspected
      // require the owner to step in.
      if (review.status === 'correction_required') {
        await sendCorrectionRequest({
          req,
          supabaseUrl,
          serviceKey,
          userId: task.user_id,
          taskId,
          assignedTo: task.assigned_to,
          correctionNote: review.note,
        }).catch((err) =>
          console.error('[task-confirm] correction WhatsApp failed (non-fatal):', err?.message || err),
        );
      } else if (review.status === 'uncertain' || review.status === 'fraud_suspected') {
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
        // The QI note for correction_required is shown inline on the
        // confirmation page so the assignee knows exactly what to fix.
        correctionNote: review.status === 'correction_required' ? review.note : null,
        correctionCycleCount: cycleCount,
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
          ...(proofImagePaths.length > 0 ? { proof_image_path: proofImagePaths[0] } : {}),
          ...(review
            ? { quality_review_status: 'approved', quality_review_note: review.note, quality_reviewed_at: now }
            : {}),
        }),
      },
    );

    if (!updateRes.ok) {
      return res.status(500).json({ error: 'Could not confirm task. Please try again.' });
    }

    if (proofImagePaths.length > 0) {
      await replaceProofAttachments({
        supabaseUrl,
        serviceKey,
        taskId,
        userId: task.user_id,
        proofImagePaths,
      }).catch((err) =>
        console.error('[task-confirm] replaceProofAttachments failed (non-fatal):', err?.message || err),
      );
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
        : variant === 'correction_limit'
          ? `${assignee ? `${assignee}'s` : 'The'} proof for "${description}" still needs correction after a follow-up attempt. Carson stopped messaging — please review.`
          : variant === 'correction_required'
            ? `${assignee || 'The assignee'} sent the wrong proof for: ${description}. Carson messaged them to resubmit.`
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

async function sendCorrectionRequest({ req, supabaseUrl, serviceKey, userId, taskId, assignedTo, correctionNote }) {
  const messageText = String(correctionNote || '').trim();
  if (!messageText || !userId || !assignedTo) return;

  const person = await findAssigneePerson({ supabaseUrl, serviceKey, userId, assignedTo });
  if (!person?.phone) {
    console.warn('[task-confirm] correction WhatsApp skipped — no assignee phone', { taskId, assignedTo });
    return;
  }

  const messageRecord = await createCorrectionMessageRecord({
    supabaseUrl,
    serviceKey,
    userId,
    recipient: person.name || assignedTo,
    messageText,
  });
  if (!messageRecord?.id) {
    console.warn('[task-confirm] correction WhatsApp skipped — message row not created', { taskId, assignedTo });
    return;
  }

  const appBaseUrl =
    (process.env.APP_BASE_URL || '').trim() ||
    `${req.headers?.['x-forwarded-proto'] || 'https'}://${req.headers?.host || 'ra7etbal.com'}`;

  const response = await fetch(`${appBaseUrl}/api/send-whatsapp-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to: person.phone,
      messageText,
      confirmationLink: null,
      messageRecordId: messageRecord.id,
      taskId: null,
      sendMode: 'direct_message',
      sourceType: 'quality_correction',
      recipientName: person.name || assignedTo,
      ownerName: null,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Correction WhatsApp send failed (${response.status}): ${text.slice(0, 200)}`);
  }
}

async function createCorrectionMessageRecord({ supabaseUrl, serviceKey, userId, recipient, messageText }) {
  const response = await fetch(`${supabaseUrl}/rest/v1/messages`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({
      user_id: userId,
      task_id: null,
      recipient,
      content: messageText,
      confirmation_url: null,
    }),
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] : null;
}

async function findAssigneePerson({ supabaseUrl, serviceKey, userId, assignedTo }) {
  if (!userId || !assignedTo) return null;
  const response = await fetch(
    supabaseUrl + '/rest/v1/people?user_id=eq.' +
      encodeURIComponent(userId) + '&select=name,phone',
    {
      headers: {
        apikey: serviceKey,
        Authorization: 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
      },
    },
  );
  if (!response.ok) return null;
  const people = await response.json().catch(() => []);
  if (!Array.isArray(people)) return null;
  const target = String(assignedTo).trim().toLowerCase();
  return people.find((person) => String(person.name || '').trim().toLowerCase() === target) ?? null;
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

/**
 * Signs one proof-photo upload slot at a fixed, index-scoped path
 * (`{userId}/{taskId}/proof/{index}.jpg`). Root cause of the historical
 * "Upload failed (400)" bug on re-upload after a Quality Intelligence
 * rejection: this signing call never set the upsert header, so a second
 * upload to the same (deterministic) path was rejected by Supabase Storage
 * as a conflict. `x-upsert: true` here is the fix — the same signed-URL
 * mechanics remain single-use per token, so the caller still needs a fresh
 * signed URL per attempt (unchanged), but the underlying object write itself
 * now succeeds on repeat submissions to the same slot.
 */
async function createSignedProofUploadUrl({ supabaseUrl, serviceKey, userId, taskId, index }) {
  if (!userId || !taskId) return null;

  const BUCKET = 'task-images';
  const objectPath = `${userId}/${taskId}/proof/${index}.jpg`;
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
          'x-upsert': 'true',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      },
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('[task-confirm] createSignedProofUploadUrl: Supabase returned non-ok', {
        index,
        status: response.status,
        body: errText.slice(0, 200),
      });
      return null;
    }
    const data = await response.json();
    if (!data?.url) {
      console.warn('[task-confirm] createSignedProofUploadUrl: no url in response', {
        index,
        keys: data ? Object.keys(data) : null,
        data: JSON.stringify(data).slice(0, 300),
      });
      return null;
    }
    const uploadUrl = `${supabaseUrl}/storage/v1${data.url}`;
    return { index, uploadUrl, storagePath };
  } catch {
    return null;
  }
}

/** Signs up to `count` proof-photo upload slots in parallel, dropping any that failed to sign. */
async function createSignedProofUploadUrls({ supabaseUrl, serviceKey, userId, taskId, count }) {
  const slots = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      createSignedProofUploadUrl({ supabaseUrl, serviceKey, userId, taskId, index }),
    ),
  );
  return slots.filter(Boolean);
}

/**
 * Replaces the full set of proof-photo rows for a task with the paths just
 * submitted. Proof rows are discriminated from reference-photo rows in the
 * same task_attachments table by file_name = 'proof' (reference rows never
 * set file_name) — no schema change needed. Delete-then-insert rather than
 * upsert-by-path, since a resubmission may have fewer photos than before
 * (a removed slot must not linger as a stale row).
 */
async function replaceProofAttachments({ supabaseUrl, serviceKey, taskId, userId, proofImagePaths }) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };

  const deleteRes = await fetch(
    `${supabaseUrl}/rest/v1/task_attachments?task_id=eq.${encodeURIComponent(taskId)}&file_name=eq.proof`,
    { method: 'DELETE', headers: { ...headers, Prefer: 'return=minimal' } },
  );
  if (!deleteRes.ok) {
    throw new Error(`Could not clear previous proof photos (status ${deleteRes.status})`);
  }

  if (proofImagePaths.length === 0) return;

  const rows = proofImagePaths.map((storagePath, index) => ({
    task_id: taskId,
    user_id: userId,
    storage_path: storagePath,
    file_name: 'proof',
    content_type: 'image/jpeg',
    sort_order: index,
  }));

  const insertRes = await fetch(`${supabaseUrl}/rest/v1/task_attachments`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!insertRes.ok) {
    throw new Error(`Could not save proof photos (status ${insertRes.status})`);
  }
}
