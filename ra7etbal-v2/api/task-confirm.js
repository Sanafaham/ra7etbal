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
 *   Marks the task as done, inserts a confirmation record, and fires a
 *   push notification to the task owner.
 */

import webpush from 'web-push';

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
        '&select=id,user_id,status,description,assigned_to',
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

    // 2. Mark task done
    const updateRes = await fetch(
      supabaseUrl + '/rest/v1/tasks?id=eq.' + encodeURIComponent(taskId),
      {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'done',
          confirmed_at: now,
          ...(proofImagePath ? { proof_image_path: proofImagePath } : {}),
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

    return res.status(200).json({ success: true, description: task.description });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

// ── Push helper ───────────────────────────────────────────────────────────────

async function sendOwnerPush({ supabaseUrl, serviceKey, userId, description, assignedTo }) {
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
  const notificationBody = assignee
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
