export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
      supabaseUrl + '/rest/v1/tasks?id=eq.' + taskId + '&select=id,user_id,description,assigned_to,status,confirmed_at,image_path,proof_image_path',
      {
        headers: {
          'apikey': serviceKey,
          'Authorization': 'Bearer ' + serviceKey,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();

    if (!response.ok || !data || data.length === 0) {
      return res.status(404).json({ error: 'This confirmation link is invalid or expired.' });
    }

    const task = data[0];
    const ownerPhone = await findOwnerPhone({
      supabaseUrl,
      serviceKey,
      userId: task.user_id
    });

    // Generate signed read URLs for reference image and existing proof photo.
    // The Confirm page is public (no auth), so we generate these server-side
    // using the service role key and return them directly.
    let imageUrl = null;
    if (task.image_path) {
      imageUrl = await getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: task.image_path });
    }

    let proofImageUrl = null;
    if (task.proof_image_path) {
      proofImageUrl = await getSignedImageUrl({ supabaseUrl, serviceKey, imagePath: task.proof_image_path });
    }

    // Generate a signed upload URL so the recipient (no auth session) can upload
    // a proof photo directly to Supabase Storage. Only needed when the task is
    // still pending — already-done tasks don't need a new upload slot.
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
      proofImageUrl,
      proofUploadUrl,
      proofUploadPath,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

async function findOwnerPhone({ supabaseUrl, serviceKey, userId }) {
  if (!userId) return null;

  const response = await fetch(
    supabaseUrl +
      '/rest/v1/people?user_id=eq.' +
      encodeURIComponent(userId) +
      '&select=name,role,phone',
    {
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json'
      }
    }
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

/**
 * Generate a 1-hour signed URL for a task image using the service role key.
 * Used for the public Confirm page where the recipient has no auth session.
 * Returns null on any error so the Confirm page degrades gracefully.
 */
async function getSignedImageUrl({ supabaseUrl, serviceKey, imagePath }) {
  if (!imagePath) return null;

  // imagePath format: "task-images/{userId}/{taskId}/photo.jpg"
  // Supabase Storage REST: POST /storage/v1/object/sign/{bucket}/{object}
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
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
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
 * Generate a 1-hour signed upload URL for the recipient to upload a proof photo.
 * The recipient has no auth session, so the server creates the token with the
 * service role key. The client can PUT directly to uploadUrl with a JPEG blob.
 *
 * Returns { uploadUrl, storagePath } or null on failure.
 * storagePath is the value to store in tasks.proof_image_path after upload.
 */
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
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiresIn: 3600 }),
      }
    );
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn('[get-confirm-task] createSignedUploadUrl: Supabase returned non-ok', {
        status: response.status,
        body: errText.slice(0, 200),
      });
      return null;
    }
    const data = await response.json();
    // Supabase upload-sign endpoint returns { url: "/object/upload/sign/{bucket}/{path}?token=<JWT>" }
    // data.url is a relative path with the token already embedded as a query param.
    // Construct the full upload URL exactly as the Supabase JS client does:
    //   new URL(this.url + data.url).toString()
    //   = {supabaseUrl}/storage/v1/object/upload/sign/{bucket}/{path}?token=<JWT>
    // (contrast with read-sign which returns { signedURL: "/object/sign/..." })
    if (!data?.url) {
      console.warn('[get-confirm-task] createSignedUploadUrl: no url in response', {
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
