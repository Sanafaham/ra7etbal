/**
 * GET /api/google-calendar-auth
 *
 * Generates a Google OAuth 2.0 authorization URL and redirects the user to it.
 * Requests read-only calendar access with offline access (to receive refresh token).
 *
 * Query params:
 *   userId  — the Supabase user ID, passed as CSRF state
 *
 * Security note:
 *   state = userId is a lightweight CSRF token for V1. A proper nonce-based
 *   CSRF check is documented as a V1.1 follow-up.
 */

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { userId } = req.query ?? {};
  if (!userId || typeof userId !== "string") {
    return res.status(400).json({ error: "userId query param required" });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    console.error("[google-calendar-auth] Missing GOOGLE_CLIENT_ID or GOOGLE_REDIRECT_URI");
    return res.status(500).json({ error: "Google Calendar not configured" });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    access_type: "offline",
    prompt: "consent",   // force refresh_token every time (re-connect resets it)
    state: userId,
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  return res.redirect(302, authUrl);
}
