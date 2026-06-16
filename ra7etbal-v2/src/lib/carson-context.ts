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
import { classifyCalendarEvent, formatEventTime, formatEventEndTime } from "./calendar";
import { derivePendingItems, formatPendingItemsForCarson } from "./pending-items";

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
  /**
   * Household-level delegation rules text (from household_rules table).
   * Injected verbatim into Carson's context so it guides assignment decisions.
   */
  householdRules?: string | null;
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

  // ── People & Household Intelligence ──────────────────────────────────────
  if (people.length > 0) {
    lines.push("PEOPLE & DELEGATION INTELLIGENCE:");
    for (const p of people.slice(0, 20)) {
      const name = p.name.trim();
      const role = p.role?.trim() ?? "";

      // Family members get special top-line treatment
      if (p.is_family) {
        const rel = p.relationship?.trim() ? ` — ${p.relationship.trim()}` : "";
        const guidance = p.delegation_guidance?.trim()
          ? ` | ${p.delegation_guidance.trim().slice(0, 200)}`
          : "";
        lines.push(`${name}${role ? ` (${role})` : ""}${rel} [FAMILY — do not treat as staff${guidance}]`);
        continue;
      }

      // Build a structured staff entry
      const parts: string[] = [];
      if (role) parts.push(role);
      if (p.relationship?.trim()) parts.push(p.relationship.trim());

      const flags: string[] = [];
      if (p.reliability_level) {
        const label: Record<string, string> = {
          very_high: "RELIABILITY: very high",
          high: "RELIABILITY: high",
          medium: "RELIABILITY: medium",
          needs_support: "RELIABILITY: needs support",
        };
        flags.push(label[p.reliability_level] ?? p.reliability_level);
      }
      if (p.follow_up_level && p.follow_up_level !== "none") {
        const label: Record<string, string> = {
          light: "FOLLOW-UP: light",
          regular: "FOLLOW-UP: required",
          high: "FOLLOW-UP: high — always check in",
        };
        flags.push(label[p.follow_up_level] ?? p.follow_up_level);
      }

      const header = `${name}${parts.length ? ` (${parts.join(", ")})` : ""}${flags.length ? ` [${flags.join(" | ")}]` : ""}`;
      lines.push(header);

      if (p.responsibilities?.trim()) {
        lines.push(`  Responsibilities: ${p.responsibilities.trim().slice(0, 250)}`);
      }
      if (p.delegation_guidance?.trim()) {
        lines.push(`  Delegation guidance: ${p.delegation_guidance.trim().slice(0, 300)}`);
      }
      if (p.should_not_assign?.trim()) {
        lines.push(`  Do NOT assign: ${p.should_not_assign.trim().slice(0, 200)}`);
      }
      if (p.escalate_to?.trim()) {
        lines.push(`  Escalate to: ${p.escalate_to.trim()}`);
      }
      if (p.communication_style?.trim()) {
        lines.push(`  Communication style: ${p.communication_style.trim().slice(0, 150)}`);
      }
      if (p.notes?.trim()) {
        lines.push(`  Notes: ${p.notes.trim().slice(0, 200)}`);
      }
      if (p.phone?.trim()) {
        lines.push(`  Phone: ${p.phone.trim()}`);
      }
    }
  } else {
    lines.push("PEOPLE: none saved.");
  }

  // ── Household Delegation Rules ────────────────────────────────────────────
  if (input.householdRules?.trim()) {
    lines.push("HOUSEHOLD DELEGATION RULES:");
    lines.push(input.householdRules.trim());
  }

  // ── Calendar ──────────────────────────────────────────────────────────────
  const calEvents = input.calendarEvents ?? [];
  if (calEvents.length > 0) {
    lines.push("CALENDAR:");
    for (const ev of calEvents.slice(0, 10)) {
      const status = classifyCalendarEvent(ev, now);
      const loc = ev.location ? ` (${ev.location})` : "";
      if (status === "in_progress") {
        const endStr = formatEventEndTime(ev);
        const startStr = ev.start
          ? new Date(ev.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : "";
        const range = startStr && endStr ? `, ${startStr}–${endStr}` : "";
        lines.push(`- In progress: ${ev.title}${range}${loc}`);
      } else if (status === "past") {
        const endStr = formatEventEndTime(ev);
        const endLabel = endStr ? `, ended ${endStr}` : "";
        lines.push(`- Past: ${ev.title}${endLabel}${loc}`);
      } else {
        const timeLabel = formatEventTime(ev, now);
        lines.push(`- Upcoming: ${timeLabel}: ${ev.title}${loc}`);
      }
    }
  }

  const unarchived = tasks.filter((t) => t.archived_at == null);
  const open = unarchived.filter((t) => t.status !== "done");

  // ── Open tasks ────────────────────────────────────────────────────────────
  if (open.length === 0) {
    lines.push("OPEN: none");
  } else {
    lines.push("OPEN:");
    const openSlice = open.slice(0, 15);
    if (open.length > 15) lines.push(`(showing 15 of ${open.length} open items)`);
    for (const t of openSlice) {
      const assigned = t.assigned_to ? `, assigned to ${t.assigned_to}` : "";
      const dueLabel = t.due_at ? formatReminderDue(t.due_at, now) : null;
      const due = dueLabel ? `, due ${dueLabel}` : "";
      lines.push(`- ${t.type}, ${t.status}${assigned}${due}: ${t.description.trim()}`);
    }
  }

  // ── Pending loops (stale, escalated, waiting — explicit open loop list) ─────
  const pendingItems = derivePendingItems(tasks, now);
  lines.push(formatPendingItemsForCarson(pendingItems, now));

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
      const by = t.assigned_to ? `, completed by ${t.assigned_to}` : "";
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
