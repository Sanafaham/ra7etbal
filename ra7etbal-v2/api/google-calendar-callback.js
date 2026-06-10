/**
 * GET /api/google-calendar-callback?code=...&state=<userId>
 *
 * Exchanges the Google auth code for tokens, stores the refresh_token in
 * profiles.google_refresh_token (server-side only — never sent to client),
 * then redirects to /settings?calendar=connected.
 *
 * On any error redirects to /settings?calendar=error so the UI can show
 * a graceful failure message.
 */

import { createClient } from "@supabase/supabase-js";

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

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

  if (!clientId || !clientSecret || !redirectUri) {
    console.error("[google-calendar-callback] Missing Google env vars");
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
      console.error("[google-calendar-callback] No refresh_token returned — user may have already granted access. Re-auth required.");
      return res.redirect(302, "/settings?calendar=error");
    }

    // ── 2. Store refresh token server-side via service role ─────────────────
    const supabase = adminClient();
    const { error: dbError } = await supabase
      .from("profiles")
      .upsert(
        {
          id: userId,
          google_refresh_token: refreshToken,
          google_calendar_connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );

    if (dbError) {
      console.error("[google-calendar-callback] DB upsert failed:", dbError.message);
      return res.redirect(302, "/settings?calendar=error");
    }

    return res.redirect(302, "/settings?calendar=connected");
  } catch (err) {
    console.error("[google-calendar-callback] Unexpected error:", err?.message);
    return res.redirect(302, "/settings?calendar=error");
  }
}
