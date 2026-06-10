/**
 * calendar.ts
 *
 * Client-side helper for Google Calendar events.
 *
 * Calls /api/google-calendar-events with the user's Supabase JWT.
 * Never receives the refresh token — only shaped event data.
 */

import { supabase } from "./supabase";

export type CalendarRange = "today" | "tomorrow" | "this_week" | "next_week";

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

    const res = await fetch(`/api/google-calendar-events?range=${range}`, {
      headers: { Authorization: `Bearer ${jwt}` },
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
