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

  // every morning / every evening / every night / every afternoon
  // "each morning" etc. — all map to daily
  if (/\b(every|each)\s+(morning|evening|night|afternoon)\b/.test(lower)) {
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
 */
export function detectRecurringSchedule(text: string): RecurringSchedule | null {
  const all = detectAllRecurringSchedules(text);
  return all.length > 0 ? all[0] : null;
}

// ── Person + message extraction (regex-first, no AI call) ─────────────────────

/**
 * Finds the first person whose name appears in the instruction.
 * Sorted by name length descending to prefer longer matches.
 */
function findPersonInInstruction(instruction: string, people: Person[]): Person | null {
  const lower = instruction.toLowerCase();
  console.log("[routine:PERSON_SEARCH]", {
    instruction: lower,
    candidates: people.map((p) => p.name?.trim().toLowerCase()),
  });
  return (
    [...people]
      .sort((a, b) => b.name.length - a.name.length)
      .find((p) => lower.includes(p.name.trim().toLowerCase())) ?? null
  );
}

// Recurring language to strip from the task message before storing in payload.
const RECURRING_CLEAN_RE =
  /\b(every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|day|week|morning|evening|night|afternoon|\d+\s+days?|[a-z]+\s+days?)|each\s+(morning|evening|night|afternoon|day)|daily|weekly|as\s+a\s+routine\s+task|as\s+a\s+routine|on\s+a\s+recurring\s+basis|recurring\s+basis|routine\s+task|regularly)\b/gi;

/**
 * Strips recurring language and the routing prefix ("ask Grace to") from an
 * instruction to produce the clean WhatsApp task message for the payload.
 */
function extractCleanTaskMessage(instruction: string, personName: string): string {
  let msg = instruction;

  // Remove recurring language
  msg = msg.replace(RECURRING_CLEAN_RE, "").replace(/\s{2,}/g, " ").trim();

  // Remove "ask/tell/have/get [name] to" routing prefix
  const escaped = personName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  msg = msg
    .replace(new RegExp(`\\b(ask|tell|have|get)\\s+${escaped}\\s+to\\s*`, "i"), "")
    .replace(new RegExp(`^\\s*${escaped}\\s+should\\s+`, "i"), "")
    .trim();

  // Remove leading connectors left behind after stripping
  msg = msg.replace(/^(and|,|,\s*and)\s*/i, "").trim();

  // Capitalise first letter
  if (msg.length > 0) {
    msg = msg.charAt(0).toUpperCase() + msg.slice(1);
  }

  return msg;
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
 * Creates a recurring routine from a voice instruction using regex-first
 * extraction (no AI call). Throws on Supabase insert failure so the widget
 * can surface a clear error rather than silently falling through.
 *
 * Returns a Carson-ready spoken summary on success, or null if the instruction
 * does not contain a recognisable person name from the contacts list.
 */
export async function createVoiceRoutine(
  opts: CreateVoiceRoutineOptions,
): Promise<string | null> {
  const { rawInstruction, schedule, people } = opts;
  const LOG = "[routine:createVoiceRoutine]";

  console.log("[routine:RAW_INSTRUCTION]", rawInstruction);
  console.log("[routine:PEOPLE_STORE]", people.map((p) => ({ id: p.id, name: p.name })));
  console.log("[routine:CREATE_ROUTINE] start", { rawInstruction, schedule, peopleCount: people.length });

  // ── 1. Detect person ───────────────────────────────────────────────────────
  const person = findPersonInInstruction(rawInstruction, people);
  console.log("[routine:PERSON_FOUND]", person?.name ?? "null");
  console.log(LOG, "person detection", { found: person?.name ?? null });

  if (!person) {
    console.warn(LOG, "no person matched in instruction — cannot create routine");
    return null;
  }

  // ── 2. Extract clean message ───────────────────────────────────────────────
  const message = extractCleanTaskMessage(rawInstruction, person.name);
  console.log(LOG, "message extraction", { raw: rawInstruction, clean: message });

  if (!message) {
    console.warn(LOG, "empty message after extraction — cannot create routine");
    return null;
  }

  // ── 3. Compute next_run_at for every_n_days ────────────────────────────────
  let nextRunAt: string | undefined;
  if (schedule.schedule === "every_n_days" && schedule.intervalDays) {
    const ms = schedule.intervalDays * 24 * 60 * 60 * 1000;
    nextRunAt = new Date(Date.now() + ms).toISOString();
  }

  // ── 4. Build routine name ──────────────────────────────────────────────────
  const schedLabel = scheduleDisplayLabel(schedule);
  const routineName = `${schedLabel} → ${person.name}`;

  const routinePayload = { person_id: person.id, message };

  console.log(LOG, "createRoutine payload", {
    name: routineName,
    type: "delegation",
    schedule: schedule.schedule,
    schedule_day: schedule.scheduleDay ?? null,
    schedule_time: "08:00",
    payload: routinePayload,
    interval_days: schedule.intervalDays ?? null,
    next_run_at: nextRunAt ?? null,
  });

  // ── 5. Insert into Supabase ────────────────────────────────────────────────
  const routine = await createRoutine({
    name: routineName,
    type: "delegation",
    schedule: schedule.schedule,
    schedule_day: schedule.scheduleDay,
    schedule_time: "08:00",
    payload: routinePayload,
    interval_days: schedule.intervalDays,
    next_run_at: nextRunAt,
  });

  console.log("[routine:SUPABASE_INSERT_SUCCESS] routine_id=" + routine.id + " name=" + routine.name);
  console.log("[routine:ROUTINE_ID]", routine.id);

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
  const dayName =
    schedule.scheduleDay != null
      ? WEEKDAY_NAMES[schedule.scheduleDay].charAt(0).toUpperCase() +
        WEEKDAY_NAMES[schedule.scheduleDay].slice(1)
      : "weekly";
  return (
    `Routine set. I'll ask ${personName} every ${dayName}: "${shortMsg}". ` +
    `You can manage it in Updates → Routines.`
  );
}
