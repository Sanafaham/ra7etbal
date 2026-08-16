/**
 * Verifies the caller's Supabase JWT before any Anthropic request is made.
 * Same auth/v1/user pattern already proven in api/automations.js and
 * api/google-calendar.js -- reused deliberately rather than inventing a new
 * mechanism. Any authenticated Ra7etBal session is sufficient: this proxy
 * holds no per-user data itself (it only forwards a prompt and returns the
 * completion), so there is no cross-user authorization concern to add --
 * only the missing "must be a real signed-in user" gate.
 */
async function requireUser(req) {
  const authHeader = req.headers?.['authorization'] ?? req.headers?.['Authorization'] ?? '';

  if (!authHeader.startsWith('Bearer ')) {
    return { error: 'Unauthorized' };
  }
  const jwt = authHeader.slice(7);

  const supabaseUrl = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return { error: 'Server configuration error.' };
  }

  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${jwt}`,
    },
  });

  if (!userRes.ok) return { error: 'Unauthorized' };

  const user = await userRes.json().catch(() => null);
  if (!user?.id) return { error: 'Unauthorized' };

  return { uid: user.id };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = await requireUser(req);
  if (auth.error) {
    return res.status(401).json({ error: auth.error });
  }

  // Key is stored in Vercel environment variables -- never hardcoded
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: controller.signal,
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ error: 'Anthropic request timed out. Please try again.' });
    }
    return res.status(500).json({ error: 'Anthropic request failed. Please try again.' });
  } finally {
    clearTimeout(timeout);
  }
}
