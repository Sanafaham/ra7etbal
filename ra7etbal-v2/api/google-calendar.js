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
 *      Supabase REST API, redirects to /?calendar=connected|error.
 *
 *   3. Fetch events      GET ?range=today|tomorrow|this_week|next_week
 *      Requires Authorization: Bearer <supabase-jwt> header.
 *      Verifies JWT, loads refresh_token, fetches Google Calendar events.
 *      Never returns refresh_token to client.
 *
 *   4. Create event      POST (JSON body)
 *      Requires Authorization: Bearer <supabase-jwt> header.
 *      Body: { title, date (YYYY-MM-DD), time (HH:MM), duration_minutes?, description? }
 *      Verifies JWT, loads refresh_token, inserts event on primary calendar.
 *      Returns: { ok: true, id, title, start, end } on success.
 *      Returns: { ok: false, code: "reconnect_required" } on scope/auth error.
 *
 * All Supabase access uses raw fetch against the REST / Auth v1 APIs.
 * No @supabase/supabase-js import.
 *
 * Scope change note (Calendar Create V1):
 *   Upgraded from calendar.readonly → calendar.events so the server can
 *   insert events. Existing users who authorized under the old read-only
 *   scope must reconnect Google Calendar in Settings to grant write access.
 */

const SCOPES = "https://www.googleapis.com/auth/calendar.events";

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
      const redirectBase = process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
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
        const errBody = await tokenRes.text();
        console.error("[google-oauth] status:", tokenRes.status);
        console.error("[google-oauth] body:", errBody);
        return res.redirect(302, `${redirectBase}/?calendar=error`);
      }

      const tokens = await tokenRes.json();
      if (!tokens.refresh_token) {
        console.error("No refresh_token in Google response");
        return res.redirect(302, `${redirectBase}/?calendar=error`);
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
        return res.redirect(302, `${redirectBase}/?calendar=error`);
      }

      return res.redirect(302, `${redirectBase}/?calendar=connected`);
    }

    // ── Route 3: Fetch events (JWT-authenticated) ─────────────────────────
    if (req.method !== "POST" && authHeader.startsWith("Bearer ")) {
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
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        res.setHeader("Surrogate-Control", "no-store");
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
          res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          res.setHeader("Surrogate-Control", "no-store");
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
      } else if (calRange === "next_7_days") {
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString();
      } else if (calRange === "next_10_days") {
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 10).toISOString();
      } else if (calRange === "next_14_days") {
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 14).toISOString();
      } else if (calRange === "next_30_days") {
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 30).toISOString();
      } else {
        // Default to today
        timeMin = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
        timeMax = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString();
      }

      // Wide ranges use higher maxResults to capture more events
      const isWideRange = ["next_7_days", "next_10_days", "next_14_days", "next_30_days",
                           "this_week", "next_week"].includes(calRange);

      // Fetch events from Google Calendar
      const eventsParams = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: isWideRange ? "50" : "20",
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

      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
      res.setHeader("Surrogate-Control", "no-store");
      return res.status(200).json({ connected: true, events });
    }

    // ── Route 4: Create event (POST, JWT-authenticated) ───────────────────
    if (req.method === "POST" && authHeader.startsWith("Bearer ")) {
      console.log("[calendar-create-debug] POST branch entered");

      const jwt = authHeader.slice(7);
      const supabaseUrl = process.env.SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

      // Verify JWT and get userId
      const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
        headers: { apikey: anonKey, Authorization: `Bearer ${jwt}` },
      });
      if (!userRes.ok) {
        console.log("[calendar-create-debug] JWT verification failed status=%d", userRes.status);
        return res.status(401).json({ ok: false, error: "Unauthorized" });
      }
      const { id: uid } = await userRes.json();
      console.log("[calendar-create-debug] userId=%s", uid ? uid.slice(0, 8) : "none");

      // Parse body — log raw type for diagnosis if body is missing/wrong
      const rawBody = req.body;
      console.log("[calendar-create-debug] req.body type=%s keys=%s",
        typeof rawBody,
        rawBody && typeof rawBody === "object" ? Object.keys(rawBody).join(",") : "n/a",
      );
      const { title, date, time, duration_minutes, description } = rawBody ?? {};
      const hasTitle = Boolean(title);
      const hasDate  = Boolean(date);
      const hasTime  = Boolean(time);
      console.log("[calendar-create-debug] fields title=%s date=%s time=%s", hasTitle, hasDate, hasTime);

      if (!title || !date || !time) {
        console.log("[calendar-create-debug] returning code=missing_fields");
        return res.status(400).json({ ok: false, code: "missing_fields", error: "title, date, and time are required." });
      }

      // Validate date (YYYY-MM-DD) and time (HH:MM)
      const dateValid = /^\d{4}-\d{2}-\d{2}$/.test(date);
      const timeValid = /^\d{2}:\d{2}$/.test(time);
      console.log("[calendar-create-debug] dateValid=%s timeValid=%s date=%s time=%s", dateValid, timeValid, date, time);
      if (!dateValid || !timeValid) {
        console.log("[calendar-create-debug] returning code=invalid_format");
        return res.status(400).json({ ok: false, code: "invalid_format", error: "date must be YYYY-MM-DD, time must be HH:MM." });
      }

      // Load refresh_token + timezone from profiles
      const profileRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=google_refresh_token,morning_brief_timezone`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
      );
      if (!profileRes.ok) {
        console.log("[calendar-create-debug] profile fetch failed status=%d", profileRes.status);
        return res.status(500).json({ ok: false, error: "Failed to load profile" });
      }
      const profiles = await profileRes.json();
      const refreshToken = profiles?.[0]?.google_refresh_token;
      const userTimezone = profiles?.[0]?.morning_brief_timezone || "Europe/Istanbul";
      console.log("[calendar-create-debug] refreshToken present=%s", Boolean(refreshToken));
      if (!refreshToken) {
        console.log("[calendar-create-debug] returning code=reconnect_required (no token in db)");
        return res.status(200).json({ ok: false, code: "reconnect_required", error: "Google Calendar is not connected." });
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
      console.log("[calendar-create-debug] token refresh status=%d", accessRes.status);
      if (!accessRes.ok) {
        const errText = await accessRes.text();
        if (accessRes.status === 400 || accessRes.status === 401) {
          console.log("[calendar-create-debug] token revoked/expired, clearing db. returning code=reconnect_required");
          // Clear revoked token
          await fetch(`${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}`, {
            method: "PATCH",
            headers: {
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({ google_refresh_token: null, google_calendar_connected_at: null }),
          });
          return res.status(200).json({ ok: false, code: "reconnect_required", error: "Google Calendar token expired. Please reconnect in Settings." });
        }
        console.error("[calendar-create-debug] token refresh unexpected failure status=%d body=%s", accessRes.status, errText);
        return res.status(502).json({ ok: false, error: "Google token refresh failed" });
      }
      const { access_token } = await accessRes.json();

      // Build event start/end datetimes.
      // Do NOT use JS Date arithmetic to compute times — Vercel runs in UTC,
      // so getTimezoneOffset() === 0 and any wall-clock time becomes UTC,
      // causing a +N hour shift for users in non-UTC zones.
      //
      // Instead: pass the user's local date/time string directly to Google
      // Calendar along with the IANA timeZone field. Google interprets the
      // dateTime as wall-clock time in that timezone — no offset math needed.
      const durationMins = Number(duration_minutes) > 0 ? Number(duration_minutes) : 60;
      const pad = (n) => String(n).padStart(2, "0");

      // Parse hour/minute to compute end time by adding durationMins
      const [startHour, startMinute] = time.split(":").map(Number);
      const totalStartMins = startHour * 60 + startMinute;
      const totalEndMins   = totalStartMins + durationMins;
      const endHour   = Math.floor(totalEndMins / 60) % 24;
      const endMinute = totalEndMins % 60;
      // Handle date rollover if end crosses midnight
      const [year, month, day] = date.split("-").map(Number);
      const endDateRollover = totalEndMins >= 1440; // 24*60
      const endDate = endDateRollover
        ? (() => {
            const d = new Date(Date.UTC(year, month - 1, day + 1));
            return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
          })()
        : date;

      // Wall-clock dateTime strings — no UTC offset appended.
      // timeZone field tells Google how to interpret them.
      const startDateTime = `${date}T${pad(startHour)}:${pad(startMinute)}:00`;
      const endDateTime   = `${endDate}T${pad(endHour)}:${pad(endMinute)}:00`;

      console.log("[calendar-create-debug] timezone=%s startDateTime=%s endDateTime=%s durationMins=%d",
        userTimezone, startDateTime, endDateTime, durationMins);

      const eventBody = {
        summary: title.trim(),
        ...(description ? { description: description.trim() } : {}),
        start: { dateTime: startDateTime, timeZone: userTimezone },
        end:   { dateTime: endDateTime,   timeZone: userTimezone },
      };

      console.log("[calendar-create-debug] attempting Google insert start=%s end=%s tz=%s durationMins=%d",
        startDateTime, endDateTime, userTimezone, durationMins);

      // Insert event via Google Calendar API
      const insertRes = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(eventBody),
        },
      );

      console.log("[calendar-create-debug] Google insert status=%d", insertRes.status);

      if (!insertRes.ok) {
        const errBody = await insertRes.text();
        // 403 = insufficient scope — user authorized under read-only, must reconnect
        if (insertRes.status === 403) {
          console.log("[calendar-create-debug] Google 403 scope insufficient. returning code=reconnect_required");
          return res.status(200).json({
            ok: false,
            code: "reconnect_required",
            error: "Google Calendar needs to be reconnected in Settings to allow event creation.",
          });
        }
        console.error("[calendar-create-debug] Google insert failed status=%d body=%s", insertRes.status, errBody);
        return res.status(502).json({ ok: false, error: "Failed to create calendar event" });
      }

      const created = await insertRes.json();
      console.log("[calendar-create-debug] returning code=success eventId=%s", created.id ?? "unknown");
      return res.status(200).json({
        ok: true,
        id: created.id,
        title: created.summary,
        start: created.start?.dateTime ?? created.start?.date ?? null,
        end:   created.end?.dateTime ?? created.end?.date ?? null,
      });
    }

    // ── No matching route ─────────────────────────────────────────────────
    return res.status(400).json({ error: "Invalid request" });

  } catch (err) {
    console.error("google-calendar handler error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
