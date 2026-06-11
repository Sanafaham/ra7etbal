/**
 * Shared Carson context builder.
 *
 * Single source of truth for the factual snapshot sent to both channels:
 *   - Text Carson  →  "Context" section of the LLM prompt
 *   - Voice Carson →  `ra7etbal_state` ElevenLabs dynamic variable
 *
 * Previously each channel had its own private formatter
 * (formatTasks/formatPeople in text-carson.ts and
 * buildElevenLabsBriefStateText in Home.tsx), which diverged silently
 * and caused "Nasira confirmed" / reminder-time mismatches.
 *
 * Rules:
 *   - Uses formatReminderDue for every time value (browser local timezone).
 *   - Reads only Supabase-backed task/person data — never UI/banner state.
 *   - Recent completions = last 5 done tasks regardless of confirmation date
 *     (not scoped to "today") so yesterday's confirmations are always visible.
 */

import type { Person } from "../types/person";
import type { Task } from "../types/task";
import type { CalendarEvent } from "./calendar";
import { formatReminderDue } from "./reminder-time";
import { formatEventTime } from "./calendar";

export interface CarsonContextInput {
  tasks: Task[];
  people: Person[];
  email?: string | null;
  now?: Date;
  /** Upcoming calendar events from Google Calendar (optional). */
  calendarEvents?: CalendarEvent[];
  /**
   * Pre-formatted notes block from formatNotesForContext().
   * Pass empty string or omit when notes aren't loaded yet.
   */
  notesBlock?: string;
}

/**
 * Returns a plain-text fact block with labelled sections.
 *
 * Example output:
 *   User email: user@example.com
 *   People: Nasira (Nanny); Grace (Driver) — prefers short messages
 *   OPEN:
 *   - reminder, pending, due Today at 9 AM: call Ahmed
 *   - delegation, pending, assigned to Nasira: send kitchen photo
 *   COMPLETED (recent, treat as history only):
 *   - send kitchen photo, confirmed by Nasira, at 6/10/2026, 2:30:00 PM
 */
export function buildCarsonContext(input: CarsonContextInput): string {
  const now = input.now ?? new Date();
  const { tasks, people, email } = input;
  const lines: string[] = [];

  // ── Identity ──────────────────────────────────────────────────────────────
  if (email) lines.push(`User email: ${email}`);

  // ── People ────────────────────────────────────────────────────────────────
  if (people.length > 0) {
    const items = people.slice(0, 12).map((p) => {
      const role = p.role?.trim() ? ` (${p.role.trim()})` : "";
      const notes = p.notes?.trim()
        ? ` — ${p.notes.trim().replace(/\s+/g, " ").slice(0, 300)}`
        : "";
      return `${p.name.trim()}${role}${notes}`;
    });
    lines.push(`People: ${items.join("; ")}`);
  } else {
    lines.push("People: none saved.");
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  const calEvents = input.calendarEvents ?? [];
  if (calEvents.length > 0) {
    lines.push("UPCOMING CALENDAR:");
    for (const ev of calEvents.slice(0, 10)) {
      const timeLabel = formatEventTime(ev, now);
      const loc = ev.location ? ` (${ev.location})` : "";
      lines.push(`- ${timeLabel}: ${ev.title}${loc}`);
    }
  }

  const unarchived = tasks.filter((t) => t.archived_at == null);
  const open = unarchived.filter((t) => t.status !== "done");

  // ── Open tasks ────────────────────────────────────────────────────────────
  if (open.length === 0) {
    lines.push("OPEN: none");
  } else {
    lines.push("OPEN:");
    for (const t of open.slice(0, 15)) {
      const assigned = t.assigned_to ? `, assigned to ${t.assigned_to}` : "";
      const dueLabel = t.due_at ? formatReminderDue(t.due_at, now) : null;
      const due = dueLabel ? `, due ${dueLabel}` : "";
      lines.push(`- ${t.type}, ${t.status}${assigned}${due}: ${t.description.trim()}`);
    }
  }

  // ── Recent completions (last 5, regardless of confirmation date) ──────────
  // Sorted by confirmed_at descending so the most recent confirmation is first.
  // "today-only" scope was the original bug — a task confirmed yesterday was
  // invisible to Voice Carson even though Text Carson still showed it.
  const done = unarchived
    .filter((t) => t.status === "done")
    .sort(
      (a, b) =>
        new Date(b.confirmed_at ?? b.created_at).getTime() -
        new Date(a.confirmed_at ?? a.created_at).getTime(),
    )
    .slice(0, 5);

  if (done.length > 0) {
    lines.push("COMPLETED (recent, treat as history only):");
    for (const t of done) {
      const by = t.assigned_to ? `, confirmed by ${t.assigned_to}` : "";
      const when = t.confirmed_at
        ? `, at ${new Date(t.confirmed_at).toLocaleString()}`
        : "";
      lines.push(`- ${t.description.trim()}${by}${when}`);
    }
  }

  // ── Saved notes ───────────────────────────────────────────────────────────
  if (input.notesBlock) lines.push(input.notesBlock);

  return lines.join("\n");
}
