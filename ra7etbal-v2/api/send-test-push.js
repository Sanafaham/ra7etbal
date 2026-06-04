import webpush from 'web-push';

/**
 * POST /api/send-test-push
 *
 * Sends a test push notification to all enabled subscriptions for the
 * signed-in user. Authentication is via the Supabase JWT passed in the
 * Authorization: Bearer <access_token> header — the token is verified
 * server-side using the Supabase Auth REST API.
 *
 * Returns:
 *   { success, sent, failed, errors }
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // 1. Extract and verify the Supabase access token
  const authorization = req.headers.authorization || req.headers.Authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ success: false, error: 'Missing authorization token.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ success: false, error: 'Server configuration error.' });
  }

  // Verify the JWT by calling Supabase Auth /user endpoint with the user's token
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${token}`,
    },
  });

  if (!userRes.ok) {
    return res.status(401).json({ success: false, error: 'Invalid or expired session. Please sign in again.' });
  }

  const userData = await userRes.json().catch(() => null);
  const userId = userData?.id;

  if (!userId) {
    return res.status(401).json({ success: false, error: 'Could not resolve user from token.' });
  }

  // 2. Check VAPID config
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || process.env.VITE_VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT;

  if (!vapidPublicKey || !vapidPrivateKey || !vapidSubject) {
    return res.status(500).json({ success: false, error: 'VAPID keys not configured on server.' });
  }

  try {
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  } catch (err) {
    return res.status(500).json({ success: false, error: `VAPID init failed: ${getErrorMessage(err)}` });
  }

  // 3. Load all enabled subscriptions for this user
  const subsUrl =
    `${supabaseUrl}/rest/v1/push_subscriptions` +
    `?select=id,endpoint,p256dh,auth` +
    `&user_id=eq.${encodeURIComponent(userId)}` +
    `&enabled=eq.true`;

  const subsRes = await fetch(subsUrl, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
  });

  if (!subsRes.ok) {
    return res.status(500).json({ success: false, error: 'Could not load push subscriptions.' });
  }

  const subscriptions = await subsRes.json().catch(() => []);

  if (!Array.isArray(subscriptions) || subscriptions.length === 0) {
    return res.status(200).json({
      success: false,
      sent: 0,
      failed: 0,
      errors: ['No enabled push subscriptions found for your account.'],
    });
  }

  // 4. Send test push to every enabled subscription
  const payload = JSON.stringify({
    title: 'Ra7etBal test',
    body: 'Push notifications are working.',
  });

  let sent = 0;
  let failed = 0;
  const errors = [];

  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        },
        payload,
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      errors.push(getErrorMessage(err));
    }
  }

  return res.status(200).json({
    success: sent > 0,
    sent,
    failed,
    errors,
  });
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}
