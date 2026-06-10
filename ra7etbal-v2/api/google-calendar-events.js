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
 * Response shape:
 *   { connected: true, events: [{ id, title, start, end, location?, allDay }] }
 *   { connected: false }          — no token stored
 *   { connected: false, revoked: true } — Google returned 401 (token revoked)
 *   { error: "..." }              — unexpected server error
 */

import { createClient } from "@supabase/supabase-js";

function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } },
  );
}

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
  // Start of today local (use UTC midnight approximation — Google handles TZ)
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
      // Next 7 days from now
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

  // ── 1. Authenticate Supabase user via JWT ───────────────────────────────
  const authHeader = req.headers.authorization ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const supabase = adminClient();
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const userId = userData.user.id;

  // ── 2. Load refresh token from profiles ─────────────────────────────────
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("google_refresh_token")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    console.error("[google-calendar-events] Profile load error:", profileError.message);
    return res.status(500).json({ error: "Server error" });
  }

  if (!profile?.google_refresh_token) {
    return res.status(200).json({ connected: false });
  }

  // ── 3. Exchange refresh token for access token ───────────────────────────
  const tokenResult = await getAccessToken(profile.google_refresh_token);

  if (!tokenResult.ok) {
    if (tokenResult.revoked) {
      // Clear stale token so UI shows disconnected state
      await supabase
        .from("profiles")
        .update({ google_refresh_token: null, google_calendar_connected_at: null })
        .eq("id", userId);
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
    // Access token unexpectedly rejected — clear stored token
    await supabase
      .from("profiles")
      .update({ google_refresh_token: null, google_calendar_connected_at: null })
      .eq("id", userId);
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
      allDay: !item.start?.dateTime, // date-only entries are all-day
    }));

  return res.status(200).json({ connected: true, events });
}
