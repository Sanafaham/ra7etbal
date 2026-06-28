/**
 * calendar-actions.ts
 *
 * Shared client-side boundary for Google Calendar mutations (create/update/
 * delete). Every calendar mutation path — Notes/To-do "Add to Calendar" and
 * the Voice create/update/delete_calendar_event tools — goes through
 * callCalendarApi() so they share one JWT-fetch-parse implementation against
 * /api/google-calendar, which remains the server-side source of truth.
 *
 * This module intentionally does NOT own conflict detection, in-session
 * cache updates, or spoken-text formatting — those stay with each caller
 * since they differ (Voice has conflict checks + an in-memory planning
 * cache; Notes/To-do do not).
 */

import { supabase } from "./supabase";

export type CalendarApiMethod = "POST" | "PATCH" | "DELETE";

export interface CalendarApiCallResult {
  ok: boolean;
  /** Parsed JSON response body, or null if the call never reached a parseable response. */
  data: Record<string, unknown> | null;
  /** Set only for failures that happen before/around the server response. */
  code?: "unauthenticated" | "parse_error" | "network_error";
}

/**
 * Calls /api/google-calendar with the current Supabase session JWT.
 *
 * Never throws — callers can branch on `code` (client-side failure) or
 * `data.code` (server-side failure, e.g. "reconnect_required", "not_found")
 * without a try/catch.
 */
export async function callCalendarApi(
  method: CalendarApiMethod,
  body: Record<string, unknown>,
): Promise<CalendarApiCallResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const jwt = sessionData?.session?.access_token;
    if (!jwt) return { ok: false, data: null, code: "unauthenticated" };

    const res = await fetch("/api/google-calendar", {
      method,
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });

    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, data: null, code: "parse_error" };
    return { ok: Boolean(data.ok), data };
  } catch {
    return { ok: false, data: null, code: "network_error" };
  }
}
