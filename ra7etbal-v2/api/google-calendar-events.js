/**
 * GET /api/google-calendar-events?range=today|tomorrow|this_week|next_week
 *
 * Fetches upcoming Google Calendar events for the authenticated Supabase user.
 * Reads the stored refresh token, exchanges it for an access token, and returns
 * events from the user's primary calendar.
 *
 * Authentication: Supabase JWT in Authorization header (Bearer token).
 * The refresh_token is NEVER returned to the client.
 *
 * Uses raw fetch against Supabase REST/Auth APIs (no @supabase/supabase-js import)
 * to keep function bundle size small — consistent with all other api/*.js files.
 *
 * Response shape:
 *   { connected: true, events: [{ id, title, start, end, location?, allDay }] }
 *   { connected: false }          — no token stored
 *   { connected: false, revoked: true } — Google returned 401 (token revoked)
 *   { error: "..." }              — unexpected server error
 */

/** Exchange a refresh token for a fresh access token. */
async function getAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (res.status === 400 || res.status === 401) {
    return { ok: false, revoked: true };
  }
  if (!res.ok) {
    return { ok: false, revoked: false };
  }

  const data = await res.json().catch(() => null);
  if (!data?.access_token) return { ok: false, revoked: false };
  return { ok: true, accessToken: data.access_token };
}

/** Compute [timeMin, timeMax] for the requested range (ISO strings). */
function getTimeRange(range) {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  switch (range) {
    case "tomorrow": {
      const start = new Date(todayStart);
      start.setDate(start.getDate() + 1);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      return [start.toISOString(), end.toISOString()];
    }
    case "this_week": {
      const end = new Date(now);
      end.setDate(end.getDate() + 7);
      return [now.toISOString(), end.toISOString()];
    }
    case "next_week": {
      const start = new Date(todayStart);
      start.setDate(start.getDate() + 7);
      const end = new Date(start);
      end.setDate(end.getDate() + 7);
      return [start.toISOString(), end.toISOString()];
    }
    case "today":
    default: {
      const end = new Date(todayStart);
      end.setDate(end.getDate() + 1);
      return [now.toISOString(), end.toISOString()];
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  // ── 1. Authenticate Supabase user via JWT ───────────────────────────────
  const authHeader = req.headers.authorization ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Verify JWT via Supabase Auth REST API
  const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: {
      "apikey": serviceKey,
      "Authorization": `Bearer ${jwt}`,
    },
  });

  if (!userRes.ok) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const userData = await userRes.json().catch(() => null);
  const userId = userData?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── 2. Load refresh token from profiles ─────────────────────────────────
  const profileRes = await fetch(
    `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=google_refresh_token`,
    {
      headers: {
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
      },
    },
  );

  if (!profileRes.ok) {
    console.error("[google-calendar-events] Profile load error:", profileRes.status);
    return res.status(500).json({ error: "Server error" });
  }

  const profiles = await profileRes.json().catch(() => []);
  const refreshToken = profiles?.[0]?.google_refresh_token;

  if (!refreshToken) {
    return res.status(200).json({ connected: false });
  }

  // ── 3. Exchange refresh token for access token ───────────────────────────
  const tokenResult = await getAccessToken(refreshToken);

  if (!tokenResult.ok) {
    if (tokenResult.revoked) {
      // Clear stale token so UI shows disconnected state
      await fetch(
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
            google_refresh_token: null,
            google_calendar_connected_at: null,
          }),
        },
      ).catch(() => {});
      return res.status(200).json({ connected: false, revoked: true });
    }
    return res.status(500).json({ error: "Could not authenticate with Google" });
  }

  // ── 4. Fetch calendar events ─────────────────────────────────────────────
  const range = (req.query?.range ?? "today").toString();
  const [timeMin, timeMax] = getTimeRange(range);

  const calUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  calUrl.searchParams.set("timeMin", timeMin);
  calUrl.searchParams.set("timeMax", timeMax);
  calUrl.searchParams.set("singleEvents", "true");
  calUrl.searchParams.set("orderBy", "startTime");
  calUrl.searchParams.set("maxResults", "20");
  calUrl.searchParams.set("fields", "items(id,summary,start,end,location,status)");

  const calRes = await fetch(calUrl.toString(), {
    headers: { Authorization: `Bearer ${tokenResult.accessToken}` },
  });

  if (calRes.status === 401) {
    // Clear stored token on auth error
    await fetch(
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
          google_refresh_token: null,
          google_calendar_connected_at: null,
        }),
      },
    ).catch(() => {});
    return res.status(200).json({ connected: false, revoked: true });
  }

  if (!calRes.ok) {
    console.error("[google-calendar-events] Calendar API error:", calRes.status);
    return res.status(500).json({ error: "Failed to fetch calendar events" });
  }

  const calData = await calRes.json().catch(() => null);
  const rawItems = calData?.items ?? [];

  // ── 5. Shape and return events (no tokens exposed) ───────────────────────
  const events = rawItems
    .filter((item) => item.status !== "cancelled")
    .map((item) => ({
      id: item.id ?? "",
      title: item.summary ?? "(no title)",
      start: item.start?.dateTime ?? item.start?.date ?? null,
      end: item.end?.dateTime ?? item.end?.date ?? null,
      location: item.location ?? null,
      allDay: !item.start?.dateTime,
    }));

  return res.status(200).json({ connected: true, events });
}
