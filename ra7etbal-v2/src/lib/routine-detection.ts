/**
 * routine-detection.ts
 *
 * Detects recurring language in a user instruction and creates a routine
 * instead of a one-time task when that language is present.
 *
 * Used by execute_instruction (Voice Carson) and Text Carson so both paths
 * handle "every two days / daily / every Monday" the same way.
 */

import type { Person } from "../types/person";
import { extractItems } from "./ai/extract";
import { createRoutine } from "./routines";
import type { RoutineSchedule } from "./routines";

// ── Schedule detection ─────────────────────────────────────────────────────────

export interface RecurringSchedule {
  schedule: RoutineSchedule;
  intervalDays?: number;   // only for every_n_days
  scheduleDay?: number;    // 0–6 (Sun–Sat), only for weekly
}

const WORD_TO_NUMBER: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const WEEKDAY_NAMES = [
  "sunday", "monday", "tuesday", "wednesday",
  "thursday", "friday", "saturday",
];

/**
 * Returns ALL recurring schedules detected in the text.
 * For "every Monday and Thursday" this returns two weekly schedules.
 * For "daily" / "every 3 days" this returns a single entry.
 */
export function detectAllRecurringSchedules(text: string): RecurringSchedule[] {
  const lower = text.toLowerCase();

  // every N days  (numeric: "every 2 days")
  const numericMatch = lower.match(/every\s+(\d+)\s+days?/);
  if (numericMatch) {
    const n = parseInt(numericMatch[1], 10);
    if (n >= 1) {
      return [n === 1 ? { schedule: "daily" } : { schedule: "every_n_days", intervalDays: n }];
    }
  }

  // every <word> days  ("every two days", "every three days")
  for (const [word, n] of Object.entries(WORD_TO_NUMBER)) {
    if (lower.includes(`every ${word} day`)) {
      return [n === 1 ? { schedule: "daily" } : { schedule: "every_n_days", intervalDays: n }];
    }
  }

  // daily / every day
  if (/\bevery\s+day\b/.test(lower) || /\bdaily\b/.test(lower)) {
    return [{ schedule: "daily" }];
  }

  // every week / weekly
  if (/\bevery\s+week\b/.test(lower) || /\bweekly\b/.test(lower)) {
    return [{ schedule: "weekly", scheduleDay: 1 }]; // Monday default
  }

  // every <weekday> — collect ALL matching weekdays so "every Monday and Thursday"
  // creates two routines rather than silently dropping Thursday.
  const weekdayMatches: RecurringSchedule[] = [];
  for (let i = 0; i < WEEKDAY_NAMES.length; i++) {
    if (lower.includes(`every ${WEEKDAY_NAMES[i]}`)) {
      weekdayMatches.push({ schedule: "weekly", scheduleDay: i });
    }
  }
  if (weekdayMatches.length > 0) return weekdayMatches;

  // "routine task" / "as a routine" / "on a recurring basis" / "regularly" —
  // treat as weekly (Monday default) when no explicit cadence is stated.
  if (
    /\broutine\s+task\b/.test(lower) ||
    /\bas\s+a\s+routine\b/.test(lower) ||
    /\bon\s+a\s+recurring\s+basis\b/.test(lower) ||
    /\brecurring\s+basis\b/.test(lower) ||
    /\bregularly\b/.test(lower)
  ) {
    return [{ schedule: "weekly", scheduleDay: 1 }];
  }

  return [];
}

/**
 * Returns the first recurring schedule found, or null.
 * Used by callers that only need to know "is this recurring at all?"
 */
export function detectRecurringSchedule(text: string): RecurringSchedule | null {
  const all = detectAllRecurringSchedules(text);
  return all.length > 0 ? all[0] : null;
}

// ── Routine creation ───────────────────────────────────────────────────────────

interface CreateVoiceRoutineOptions {
  rawInstruction: string;
  schedule: RecurringSchedule;
  people: Person[];
  userId: string;
  displayName: string | null;
}

/**
 * Extracts the delegation target and message from the instruction via AI,
 * then creates a routine row in the database.
 *
 * Returns a Carson-ready spoken summary on success, or null if the
 * instruction does not resolve to a delegation (fallback to normal path).
 */
export async function createVoiceRoutine(
  opts: CreateVoiceRoutineOptions,
): Promise<string | null> {
  const { rawInstruction, schedule, people, displayName } = opts;

  // Use the existing extraction pipeline to identify person + task message.
  const result = await extractItems(rawInstruction, people, displayName ?? undefined);

  const delegation = result.extracted.find(
    (item) => item.type === "delegation" || item.type === "message",
  );

  if (!delegation) return null; // not a delegation — fall through to normal path

  const assignedTo = (delegation.assignedTo ?? "").trim();
  if (!assignedTo) return null;

  // Resolve person_id from the people store (case-insensitive name match).
  const person = people.find(
    (p) => p.name.trim().toLowerCase() === assignedTo.toLowerCase(),
  );

  if (!person) {
    // Person not in contacts — cannot create a routine without a person_id.
    return null;
  }

  const message = delegation.description.trim();
  if (!message) return null;

  // Compute next_run_at for every_n_days (seed: now + interval).
  let nextRunAt: string | undefined;
  if (schedule.schedule === "every_n_days" && schedule.intervalDays) {
    const ms = schedule.intervalDays * 24 * 60 * 60 * 1000;
    nextRunAt = new Date(Date.now() + ms).toISOString();
  }

  // Build a human-readable routine name.
  const scheduleLabel = scheduleDisplayLabel(schedule);
  const routineName = `${scheduleLabel} → ${person.name}`;

  await createRoutine({
    name: routineName,
    type: "delegation",
    schedule: schedule.schedule,
    schedule_day: schedule.scheduleDay,
    schedule_time: "08:00", // sensible default; user can edit in Routines
    payload: { person_id: person.id, message },
    interval_days: schedule.intervalDays,
    next_run_at: nextRunAt,
  });

  return buildRoutineSummary(person.name, message, schedule);
}

// ── Display helpers ────────────────────────────────────────────────────────────

function scheduleDisplayLabel(s: RecurringSchedule): string {
  if (s.schedule === "every_n_days") return `Every ${s.intervalDays}d`;
  if (s.schedule === "daily") return "Daily";
  if (s.schedule === "weekly") {
    const day = s.scheduleDay != null ? WEEKDAY_NAMES[s.scheduleDay] : "weekly";
    return `Every ${day.charAt(0).toUpperCase() + day.slice(1)}`;
  }
  return "Recurring";
}

function buildRoutineSummary(
  personName: string,
  message: string,
  schedule: RecurringSchedule,
): string {
  const shortMsg = message.length > 60 ? message.slice(0, 60).trimEnd() + "…" : message;

  if (schedule.schedule === "every_n_days" && schedule.intervalDays) {
    const unit = schedule.intervalDays === 1 ? "day" : "days";
    return (
      `Routine set. I'll ask ${personName} every ${schedule.intervalDays} ${unit}: ` +
      `"${shortMsg}". You can manage it in Updates → Routines.`
    );
  }
  if (schedule.schedule === "daily") {
    return (
      `Routine set. I'll ask ${personName} daily: "${shortMsg}". ` +
      `You can manage it in Updates → Routines.`
    );
  }
  const dayName = schedule.scheduleDay != null
    ? WEEKDAY_NAMES[schedule.scheduleDay].charAt(0).toUpperCase() +
      WEEKDAY_NAMES[schedule.scheduleDay].slice(1)
    : "weekly";
  return (
    `Routine set. I'll ask ${personName} every ${dayName}: "${shortMsg}". ` +
    `You can manage it in Updates → Routines.`
  );
}
