/**
 * GET /api/google-calendar-callback?code=...&state=<userId>
 *
 * Exchanges the Google auth code for tokens, stores the refresh_token in
 * profiles.google_refresh_token (server-side only — never sent to client),
 * then redirects to /settings?calendar=connected.
 *
 * On any error redirects to /settings?calendar=error so the UI can show
 * a graceful failure message.
 *
 * Uses raw fetch against Supabase REST API (no @supabase/supabase-js import)
 * to keep function bundle size small — consistent with all other api/*.js files.
 */

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { code, state: userId, error: oauthError } = req.query ?? {};

  // User denied consent or Google returned an error
  if (oauthError) {
    console.warn("[google-calendar-callback] OAuth error:", oauthError);
    return res.redirect(302, "/settings?calendar=error");
  }

  if (!code || !userId) {
    return res.redirect(302, "/settings?calendar=error");
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!clientId || !clientSecret || !redirectUri || !supabaseUrl || !serviceKey) {
    console.error("[google-calendar-callback] Missing required env vars");
    return res.redirect(302, "/settings?calendar=error");
  }

  try {
    // ── 1. Exchange code for tokens ─────────────────────────────────────────
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }).toString(),
    });

    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => "");
      console.error("[google-calendar-callback] Token exchange failed:", body);
      return res.redirect(302, "/settings?calendar=error");
    }

    const tokens = await tokenRes.json().catch(() => null);
    const refreshToken = tokens?.refresh_token;

    if (!refreshToken) {
      console.error("[google-calendar-callback] No refresh_token returned");
      return res.redirect(302, "/settings?calendar=error");
    }

    // ── 2. Upsert refresh token via Supabase REST API ────────────────────────
    const upsertRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "apikey": serviceKey,
          "Authorization": `Bearer ${serviceKey}`,
          "Prefer": "return=minimal",
        },
        body: JSON.stringify({
          google_refresh_token: refreshToken,
          google_calendar_connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      },
    );

    if (!upsertRes.ok) {
      const body = await upsertRes.text().catch(() => "");
      console.error("[google-calendar-callback] DB patch failed:", upsertRes.status, body);
      return res.redirect(302, "/settings?calendar=error");
    }

    return res.redirect(302, "/settings?calendar=connected");
  } catch (err) {
    console.error("[google-calendar-callback] Unexpected error:", err?.message);
    return res.redirect(302, "/settings?calendar=error");
  }
}
