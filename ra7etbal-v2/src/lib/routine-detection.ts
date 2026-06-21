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

  // ── 4. Parse schedule_time from raw instruction ────────────────────────────
  // "at 9 AM" / "at 9:30 AM" / "at 21:00" — fallback to 09:00
  const scheduleTime = extractTimeFromInstruction(rawInstruction) ?? "09:00";

  // ── 5. Build routine name from message content ─────────────────────────────
  const shortMsg = message.length > 40 ? message.slice(0, 40).trimEnd() + "…" : message;
  const schedLabel = scheduleDisplayLabel(schedule);
  const routineName = `${schedLabel}: ${shortMsg}`;

  const routinePayload = { person_id: person.id, message };

  console.log(LOG, "createRoutine payload", {
    name: routineName,
    type: "delegation",
    schedule: schedule.schedule,
    schedule_day: schedule.scheduleDay ?? null,
    schedule_time: scheduleTime,
    payload: routinePayload,
    interval_days: schedule.intervalDays ?? null,
    next_run_at: nextRunAt ?? null,
  });

  // ── 6. Insert into Supabase ────────────────────────────────────────────────
  const routine = await createRoutine({
    name: routineName,
    type: "delegation",
    schedule: schedule.schedule,
    schedule_day: schedule.scheduleDay,
    schedule_time: scheduleTime,
    payload: routinePayload,
    interval_days: schedule.intervalDays,
    next_run_at: nextRunAt,
  });

  console.log("[routine:SUPABASE_INSERT_SUCCESS] routine_id=" + routine.id + " name=" + routine.name);
  console.log("[routine:ROUTINE_ID]", routine.id);

  return buildRoutineSummary(person.name, message, schedule);
}

// ── Voice automation builder (Phase 1 — routes to automations table) ──────────

export type AutomationType = 'delegation' | 'message';

export interface VoiceAutomationInput {
  assigneeId: string;
  personName: string;
  cleanMessage: string;
  cadenceType: 'daily' | 'weekly' | 'every_n_days';
  cadenceValue: Record<string, unknown>;
  title: string;
  summary: string;
  automationType: AutomationType;
}

/**
 * Returns 'message' only for explicit phrasing where the user is clearly sending
 * a personal message rather than delegating a task.
 *
 * Triggers on: "message X", "send X a message", "tell X", "text X"
 * Does NOT trigger on: "ask X to", "have X", "get X to", "remind X", soft emotional language alone.
 */
export function detectAutomationType(instruction: string): AutomationType {
  const lower = instruction.toLowerCase();
  // Must match at the start of the meaningful phrase, not buried in a task description.
  // "message Grace every morning" / "send Grace a message" / "tell Grace" / "text Grace"
  if (
    /^\s*(message|msg)\s+\w/i.test(lower) ||
    /\bsend\s+\w[\w\s]*\s+a\s+message\b/i.test(lower) ||
    /^\s*tell\s+\w/i.test(lower) ||
    /^\s*text\s+\w/i.test(lower)
  ) {
    return 'message';
  }
  return 'delegation';
}

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Builds a structured automation payload from a voice instruction.
 * Returns null when no person is found (e.g. personal message — Phase 2).
 *
 * Pass `resolvedPerson` when the caller already knows the person (e.g. sendDelegation).
 */
export function buildVoiceAutomationInput(
  rawInstruction: string,
  schedule: RecurringSchedule,
  people: Person[],
  resolvedPerson?: Person,
): VoiceAutomationInput | null {
  const person = resolvedPerson ?? findPersonInInstruction(rawInstruction, people);
  if (!person) return null;

  const cleanMessage = extractCleanTaskMessage(rawInstruction, person.name);
  if (!cleanMessage) return null;

  const scheduleTime = extractTimeFromInstruction(rawInstruction) ?? '09:00';

  type CadenceType = 'daily' | 'weekly' | 'every_n_days';
  let cadenceType: CadenceType;
  let cadenceValue: Record<string, unknown> = { time: scheduleTime };

  if (schedule.schedule === 'every_n_days' && schedule.intervalDays) {
    cadenceType = 'every_n_days';
    cadenceValue = { n: schedule.intervalDays, time: scheduleTime };
  } else if (schedule.schedule === 'weekly') {
    cadenceType = 'weekly';
  } else {
    cadenceType = 'daily';
  }

  const shortMsg =
    cleanMessage.length > 40 ? cleanMessage.slice(0, 40).trimEnd() + '…' : cleanMessage;
  const cadenceLabel =
    cadenceType === 'every_n_days' && schedule.intervalDays
      ? `Every ${schedule.intervalDays}d`
      : cadenceType === 'weekly' && schedule.scheduleDay != null
        ? `Every ${WEEKDAY_SHORT[schedule.scheduleDay]}`
        : 'Daily';
  const title = `${cadenceLabel}: ${shortMsg}`;

  const automationType = detectAutomationType(rawInstruction);
  const summaryBase = buildAutomationSummary(person.name, cleanMessage, schedule, automationType);

  return {
    assigneeId: person.id,
    personName: person.name,
    cleanMessage,
    cadenceType,
    cadenceValue,
    title,
    summary: summaryBase,
    automationType,
  };
}

function buildAutomationSummary(
  personName: string,
  message: string,
  schedule: RecurringSchedule,
  automationType: AutomationType = 'delegation',
): string {
  const shortMsg = message.length > 60 ? message.slice(0, 60).trimEnd() + '…' : message;
  const verb = automationType === 'message' ? "I'll message" : "I'll ask";

  if (schedule.schedule === 'every_n_days' && schedule.intervalDays) {
    const unit = schedule.intervalDays === 1 ? 'day' : 'days';
    return (
      `Automation set. ${verb} ${personName} every ${schedule.intervalDays} ${unit}: ` +
      `"${shortMsg}". You can manage it in Automations.`
    );
  }
  if (schedule.schedule === 'daily') {
    return (
      `Automation set. ${verb} ${personName} daily: "${shortMsg}". ` +
      `You can manage it in Automations.`
    );
  }
  const dayName =
    schedule.scheduleDay != null
      ? WEEKDAY_NAMES[schedule.scheduleDay].charAt(0).toUpperCase() +
        WEEKDAY_NAMES[schedule.scheduleDay].slice(1)
      : 'weekly';
  return (
    `Automation set. ${verb} ${personName} every ${dayName}: "${shortMsg}". ` +
    `You can manage it in Automations.`
  );
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

/**
 * Extracts a HH:MM schedule_time string from a natural-language instruction.
 * Returns null when no time phrase is found.
 *
 * Handles: "at 9 AM", "at 9:30 AM", "at 21:00", "at noon", "at midnight"
 */
export function extractTimeFromInstruction(text: string): string | null {
  const lower = text.toLowerCase();

  if (/\bnoon\b/.test(lower)) return "12:00";
  if (/\bmidnight\b/.test(lower)) return "00:00";

  // "at 9:30 AM" / "at 09:30" / "at 9 AM"
  const match = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const minute = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];

  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Normalizes LLM-rewritten cadence phrases back to canonical forms before
 * detection. Prevents the LLM from hallucinating a specific weekday (e.g.
 * "every Sunday") when the user said "every morning" or "every day".
 *
 * Only strips the weekday if the source ALSO contains a time-of-day word that
 * implies daily cadence — so "every Sunday" alone stays weekly.
 */
export function normalizeCadenceText(text: string): string {
  const lower = text.toLowerCase();

  // "every <weekday> morning/evening/night" → "every morning/evening/night"
  // The LLM often picks the next-occurring weekday when the user said "every morning".
  const dailyMarkers = /\b(morning|evening|night|afternoon)\b/.test(lower);
  if (dailyMarkers) {
    return text.replace(
      /\bevery\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi,
      "every morning",
    );
  }
  return text;
}
