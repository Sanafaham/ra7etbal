/**
 * calendar.ts
 *
 * Client-side helper for Google Calendar events.
 *
 * Calls /api/google-calendar with the user's Supabase JWT.
 * Never receives the refresh token — only shaped event data.
 */

import { supabase } from "./supabase";

export type CalendarRange =
  | "today"
  | "tomorrow"
  | "this_week"
  | "next_week"
  | "next_7_days"
  | "next_10_days"
  | "next_14_days"
  | "next_30_days";

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO datetime string, or null for all-day events. */
  start: string | null;
  end: string | null;
  location: string | null;
  allDay: boolean;
}

export interface CalendarResult {
  connected: boolean;
  /** true when Google revoked the token — show "reconnect" UI */
  revoked?: boolean;
  events: CalendarEvent[];
}

/**
 * Fetch upcoming calendar events for the authenticated user.
 *
 * Returns { connected: false, events: [] } when no Google Calendar is linked
 * or on any fetch error (never throws — safe for fire-and-load patterns).
 */
export async function fetchCalendarEvents(
  range: CalendarRange = "today",
): Promise<CalendarResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const jwt = sessionData?.session?.access_token;
    if (!jwt) return { connected: false, events: [] };

    const res = await fetch(`/api/google-calendar?range=${range}`, {
      headers: { Authorization: `Bearer ${jwt}` },
      cache: "no-store",
    });

    if (!res.ok) return { connected: false, events: [] };

    const body = await res.json().catch(() => null);
    if (!body) return { connected: false, events: [] };

    if (!body.connected) {
      return { connected: false, revoked: body.revoked ?? false, events: [] };
    }

    return { connected: true, events: body.events ?? [] };
  } catch {
    return { connected: false, events: [] };
  }
}

/**
 * Formats a CalendarEvent start time as a short human-readable label
 * e.g. "Today 4:00 PM", "Tomorrow 10:30 AM", "Mon 9:00 AM"
 */
export function formatEventTime(event: CalendarEvent, now = new Date()): string {
  if (event.allDay || !event.start) return "All day";

  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return "";

  const sameDay = isSameLocalDay(start, now);
  const tomorrow = isSameLocalDay(start, new Date(now.getTime() + 86_400_000));

  const timeStr = start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (sameDay) return `Today ${timeStr}`;
  if (tomorrow) return `Tomorrow ${timeStr}`;

  const dayStr = start.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${dayStr} ${timeStr}`;
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export type CalendarEventStatus = "upcoming" | "in_progress" | "past";

/**
 * Classifies a CalendarEvent relative to the given time.
 *
 * - all-day events are never "past" during the same calendar day.
 * - If end is missing, end is assumed to be start + 1 hour.
 * - "in_progress" means started but not yet ended.
 */
export function classifyCalendarEvent(
  event: CalendarEvent,
  now = new Date(),
): CalendarEventStatus {
  // All-day events are always "upcoming" for the day — never "in_progress".
  // Saying "You're currently in [event]" sounds unnatural for all-day events.
  if (event.allDay || !event.start) return "upcoming";

  const start = new Date(event.start);
  if (Number.isNaN(start.getTime())) return "upcoming";

  const end = event.end
    ? new Date(event.end)
    : new Date(start.getTime() + 60 * 60 * 1000); // fallback: start + 1 h

  if (now >= end) return "past";
  if (now >= start) return "in_progress";
  return "upcoming";
}

/**
 * Filters a list of CalendarEvents to those whose start date falls within the
 * given range, computed relative to `now` in the user's local timezone.
 *
 * All-day events (start is a date-only string like "2026-06-13") are parsed
 * as local midnight to avoid UTC-offset date-shift bugs.
 */
export function filterCalendarEventsByRange(
  events: CalendarEvent[],
  range: CalendarRange,
  now = new Date(),
): CalendarEvent[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let rangeStart: Date;
  let rangeEnd: Date;

  switch (range) {
    case "today":
      rangeStart = today;
      rangeEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      break;
    case "tomorrow":
      rangeStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
      rangeEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2);
      break;
    case "this_week": {
      // Start from today (not last Sunday) so the range aligns with the
      // planning cache, which only contains events from today onward.
      // rangeEnd = next Sunday (start of next week).
      const dow = now.getDay();
      rangeStart = today;
      rangeEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (7 - dow));
      break;
    }
    case "next_week": {
      const dow = now.getDay();
      rangeStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow + 7);
      rangeEnd = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate() + 7);
      break;
    }
    case "next_7_days":
      rangeStart = today;
      rangeEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
      break;
    case "next_10_days":
      rangeStart = today;
      rangeEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 10);
      break;
    case "next_14_days":
      rangeStart = today;
      rangeEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14);
      break;
    case "next_30_days":
    default:
      rangeStart = today;
      rangeEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 30);
      break;
  }

  return events.filter((ev) => {
    if (!ev.start) return false;
    let eventDate: Date;
    if (ev.allDay) {
      // Date-only strings ("2026-06-13") — parse as local midnight to avoid
      // UTC offset shifting the date by one day in non-UTC timezones.
      const parts = ev.start.split("-").map(Number);
      if (parts.length < 3) return false;
      eventDate = new Date(parts[0], parts[1] - 1, parts[2]);
    } else {
      const parsed = new Date(ev.start);
      if (Number.isNaN(parsed.getTime())) return false;
      eventDate = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
    }
    return eventDate >= rangeStart && eventDate < rangeEnd;
  });
}

/**
 * Formats an event end time as a short human-readable label, e.g. "8:30 PM".
 * Returns "" for all-day events or when end is unavailable.
 */
export function formatEventEndTime(event: CalendarEvent): string {
  if (event.allDay || !event.end) return "";
  const end = new Date(event.end);
  if (Number.isNaN(end.getTime())) return "";
  return end.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export interface CreateCalendarEventResult {
  ok: boolean;
  /** Google Calendar event ID. Present on success. */
  id?: string;
  title?: string;
  /** ISO datetime string for the event start. Present on success. */
  start?: string;
  /** ISO datetime string for the event end. Present on success. */
  end?: string;
  /** Machine-readable error code returned by the server. */
  code?: string;
}

/**
 * Create a Google Calendar event on the user's primary calendar.
 *
 * Calls POST /api/google-calendar with the current Supabase JWT.
 * Never throws — returns { ok: false, code } on any failure so callers
 * can surface a typed inline error without a try/catch.
 *
 * @param title           Event title.
 * @param date            Local date in YYYY-MM-DD format.
 * @param time            Local 24-hour time in HH:MM format.
 * @param durationMinutes Event length in minutes (default 60).
 */
export async function createCalendarEvent(
  title: string,
  date: string,
  time: string,
  durationMinutes = 60,
): Promise<CreateCalendarEventResult> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const jwt = sessionData?.session?.access_token;
    if (!jwt) return { ok: false, code: "unauthenticated" };

    const res = await fetch("/api/google-calendar", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title, date, time, duration_minutes: durationMinutes }),
      cache: "no-store",
    });

    const data = await res.json().catch(() => null);
    if (!data) return { ok: false, code: "parse_error" };
    return data as CreateCalendarEventResult;
  } catch {
    return { ok: false, code: "network_error" };
  }
}
