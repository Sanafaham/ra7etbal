/**
 * /api/google-calendar — unified Google Calendar handler (no SDK imports)
 *
 * Routes (determined by query params / headers):
 *
 *   1. OAuth initiation  GET ?userId=<uid>
 *      Redirects user to Google consent screen.
 *
 *   2. OAuth callback    GET ?code=<code>&state=<uid>
 *      Exchanges code for tokens, stores refresh_token in profiles via
 *      Supabase REST API, redirects to /settings?calendar=connected|error.
 *
 *   3. Fetch events      GET ?range=today|tomorrow|this_week|next_week
 *      Requires Authorization: Bearer <supabase-jwt> header.
 *      Verifies JWT, loads refresh_token, fetches Google Calendar events.
 *      Never returns refresh_token to client.
 *
 * All Supabase access uses raw fetch against the REST / Auth v1 APIs.
 * No @supabase/supabase-js import.
 */

const SCOPES = "https://www.googleapis.com/auth/calendar.readonly";

export default async function handler(req, res) {
  const { code, state, userId, range } = req.query;
  const authHeader = req.headers["authorization"] ?? "";

  try {
    // ── Route 1: OAuth initiation ─────────────────────────────────────────
    if (userId && !code && !authHeader) {
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        response_type: "code",
        scope: SCOPES,
        access_type: "offline",
        prompt: "consent",
        state: userId,
      });
      return res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }

    // ── Route 2: OAuth callback ───────────────────────────────────────────
    if (code && state) {
      const uid = state;
      const redirectBase = process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:5173";

      // Exchange code for tokens
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: process.env.GOOGLE_REDIRECT_URI,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        console.error("Google token exchange failed:", await tokenRes.text());
        return res.redirect(302, `${redirectBase}/settings?calendar=error`);
      }

      const tokens = await tokenRes.json();
      if (!tokens.refresh_token) {
        console.error("No refresh_token in Google response");
        return res.redirect(302, `${redirectBase}/settings?calendar=error`);
      }

      // Store refresh_token in profiles via Supabase REST API
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

      const patchRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}`,
        {
          method: "PATCH",
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: JSON.stringify({
            google_refresh_token: tokens.refresh_token,
            google_calendar_connected_at: new Date().toISOString(),
          }),
        },
      );

      if (!patchRes.ok) {
        console.error("Supabase PATCH failed:", await patchRes.text());
        return res.redirect(302, `${redirectBase}/settings?calendar=error`);
      }

      return res.redirect(302, `${redirectBase}/settings?calendar=connected`);
    }

    // ── Route 3: Fetch events (JWT-authenticated) ─────────────────────────
    if (authHeader.startsWith("Bearer ")) {
      const jwt = authHeader.slice(7);
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

      // Verify JWT and get userId
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${jwt}`,
        },
      });

      if (!userRes.ok) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id: uid } = await userRes.json();

      // Load refresh_token from profiles
      const profileRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=google_refresh_token`,
        {
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
        },
      );

      if (!profileRes.ok) {
        return res.status(500).json({ error: "Failed to load profile" });
      }

      const profiles = await profileRes.json();
      const refreshToken = profiles?.[0]?.google_refresh_token;

      if (!refreshToken) {
        return res.status(200).json({ connected: false, events: [] });
      }

      // Exchange refresh_token for access_token
      const accessRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });

      if (!accessRes.ok) {
        const errText = await accessRes.text();
        // Revoked / expired token — clear from DB
        if (accessRes.status === 400 || accessRes.status === 401) {
          await fetch(
            `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}`,
            {
              method: "PATCH",
              headers: {
                apikey: serviceKey,
                Authorization: `Bearer ${serviceKey}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({
                google_refresh_token: null,
                google_calendar_connected_at: null,
              }),
            },
          );
          return res.status(200).json({ connected: false, revoked: true, events: [] });
        }
        console.error("Google refresh failed:", errText);
        return res.status(502).json({ error: "Google token refresh failed" });
      }

      const { access_token } = await accessRes.json();

      // Calculate time range
      const calRange = range || "today";
      const now = new Date();
      let timeMin, timeMax;

      if (calRange === "today") {
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      } else if (calRange === "tomorrow") {
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).toISOString();
      } else if (calRange === "this_week") {
        const dayOfWeek = now.getDay();
        const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
        timeMin = startOfWeek.toISOString();
        timeMax = new Date(startOfWeek.getFullYear(), startOfWeek.getMonth(), startOfWeek.getDate() + 7).toISOString();
      } else if (calRange === "next_week") {
        const dayOfWeek = now.getDay();
        const startOfNext = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek + 7);
        timeMin = startOfNext.toISOString();
        timeMax = new Date(startOfNext.getFullYear(), startOfNext.getMonth(), startOfNext.getDate() + 7).toISOString();
      } else {
        // Default to today
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      }

      // Fetch events from Google Calendar
      const eventsParams = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "20",
      });

      const eventsRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${eventsParams}`,
        {
          headers: { Authorization: `Bearer ${access_token}` },
        },
      );

      if (!eventsRes.ok) {
        console.error("Google Calendar events fetch failed:", await eventsRes.text());
        return res.status(502).json({ error: "Failed to fetch calendar events" });
      }

      const data = await eventsRes.json();
      const events = (data.items ?? []).map((item) => {
        const allDay = Boolean(item.start?.date && !item.start?.dateTime);
        return {
          id: item.id,
          title: item.summary ?? "(No title)",
          start: item.start?.dateTime ?? item.start?.date ?? null,
          end: item.end?.dateTime ?? item.end?.date ?? null,
          location: item.location ?? null,
          allDay,
        };
      });

      return res.status(200).json({ connected: true, events });
    }

    // ── No matching route ─────────────────────────────────────────────────
    return res.status(400).json({ error: "Invalid request" });

  } catch (err) {
    console.error("google-calendar handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
