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
import { LEGACY_ROUTINE_CREATION_FROZEN_MESSAGE } from "./routines";
import type { RoutineSchedule } from "./routines";
import { supabase } from "./supabase";

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

  // Open-ended recurring intent — "every day UNTIL I TELL YOU TO STOP",
  // "until told otherwise", "until further notice". Checked independently of
  // the "every day" match above (not just as a fallback) so this phrase alone
  // still triggers recurring detection even if "every day" itself is absent
  // from whichever candidate source is being checked — voice transcription
  // and LLM rewriting have both been observed to drop one cadence phrase
  // while preserving another in the same utterance.
  if (
    /\buntil\s+(?:i\s+)?tell\s+you\s+to\s+stop\b/.test(lower) ||
    /\buntil\s+(?:(?:i|you)\s+)?(?:hear|told)\s+otherwise\b/.test(lower) ||
    /\buntil\s+further\s+notice\b/.test(lower)
  ) {
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
export function findPersonInInstruction(instruction: string, people: Person[]): Person | null {
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

export function resolveRecurringAutomationPerson(
  recurringSource: string,
  people: Person[],
  fallbackPerson: Person,
): Person {
  return findPersonInInstruction(recurringSource, people) ?? fallbackPerson;
}

// Recurring language to strip from the task message before storing in payload.
const RECURRING_CLEAN_RE =
  /\b(every\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|day|week|morning|evening|night|afternoon|\d+\s+days?|[a-z]+\s+days?)|each\s+(morning|evening|night|afternoon|day)|daily|weekly|as\s+a\s+routine\s+task|as\s+a\s+routine|on\s+a\s+recurring\s+basis|recurring\s+basis|routine\s+task|regularly|until\s+(?:i\s+)?tell\s+you\s+to\s+stop|until\s+(?:(?:i|you)\s+)?(?:hear|told)\s+otherwise|until\s+further\s+notice)\b/gi;

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
 * Legacy delegated-routine creation is frozen. This helper is kept only as a
 * defensive compatibility boundary: it still validates whether the instruction
 * could have been a person-based routine, but never inserts a routines row.
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

  console.warn(LOG, "legacy routine creation frozen", {
    personName: person.name,
    schedule: schedule.schedule,
  });
  return LEGACY_ROUTINE_CREATION_FROZEN_MESSAGE;
}

// Leading "remind me to/that/about" — stripped after cadence language so a
// self-directed reminder title reads as the action itself ("Take my
// medication."), not as the instruction phrasing.
const REMIND_ME_PREFIX_RE = /^\s*(?:please\s+)?remind\s+me\s+(?:to\s+|that\s+|about\s+)?/i;

/**
 * Strips recurring/time language and the "remind me to" prefix from a
 * self-directed recurring instruction to produce the reminder's title.
 */
function extractReminderTitle(instruction: string): string {
  let msg = instruction;
  msg = msg.replace(RECURRING_CLEAN_RE, "").replace(/\s{2,}/g, " ").trim();
  msg = msg.replace(REMIND_ME_PREFIX_RE, "").trim();
  msg = msg.replace(TIME_PHRASE_RE, "").replace(/\s{2,}/g, " ").trim();
  msg = msg.replace(/^(and|,|,\s*and)\s*/i, "").trim();
  if (msg.length > 0) msg = msg.charAt(0).toUpperCase() + msg.slice(1);
  return msg;
}

function buildReminderRoutineSummary(title: string, schedule: RecurringSchedule): string {
  const shortTitle = title.length > 60 ? title.slice(0, 60).trimEnd() + "…" : title;
  const label = scheduleDisplayLabel(schedule).toLowerCase();
  return (
    `Reminder set. I'll remind you ${label}: "${shortTitle}". ` +
    `You can manage it in Automations.`
  );
}

function computeOwnerAutomationNextRunAt(schedule: RecurringSchedule, scheduleTime: string): string {
  const [hh, mm] = scheduleTime.split(":").map((part) => parseInt(part, 10));
  const now = new Date();
  const next = new Date(now);
  next.setHours(Number.isFinite(hh) ? hh : 9, Number.isFinite(mm) ? mm : 0, 0, 0);

  if (schedule.schedule === "every_n_days" && schedule.intervalDays) {
    next.setDate(now.getDate() + schedule.intervalDays);
    return next.toISOString();
  }

  if (schedule.schedule === "weekly") {
    const targetDay = schedule.scheduleDay ?? 1;
    const today = now.getDay();
    let daysUntil = (targetDay - today + 7) % 7;
    if (daysUntil === 0 && next <= now) daysUntil = 7;
    next.setDate(now.getDate() + daysUntil);
    return next.toISOString();
  }

  if (next <= now) {
    next.setDate(now.getDate() + 1);
  }
  return next.toISOString();
}

/**
 * Creates a Carson-native owner-only automation for a self-directed recurring
 * instruction, used when no person is found in the text. The automation runner
 * creates the owner task and sends the owner push; no WhatsApp path is involved.
 * Third-party recurring instructions are untouched and keep using the existing
 * person-based automation/routine paths.
 *
 * Returns null only if no usable title remains after stripping cadence
 * language — callers should fall back to the existing "could not understand"
 * messaging in that case, same as today.
 */
export async function createReminderRoutineFromInstruction(
  rawInstruction: string,
  schedule: RecurringSchedule,
): Promise<string | null> {
  const title = extractReminderTitle(rawInstruction);
  if (!title) return null;

  const scheduleTime = extractTimeFromInstruction(rawInstruction) ?? "09:00";
  const shortTitle = title.length > 40 ? title.slice(0, 40).trimEnd() + "…" : title;
  const routineName = `${scheduleDisplayLabel(schedule)}: ${shortTitle}`;

  const { data: sessionData } = await supabase.auth.getSession();
  const jwt = sessionData?.session?.access_token;
  if (!jwt) throw new Error("Not authenticated.");

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cadenceType =
    schedule.schedule === "every_n_days"
      ? "every_n_days"
      : schedule.schedule === "weekly"
        ? "weekly"
        : "daily";
  const cadenceValue: Record<string, unknown> = { time: scheduleTime };
  if (schedule.schedule === "every_n_days" && schedule.intervalDays) {
    cadenceValue.n = schedule.intervalDays;
  }
  if (schedule.schedule === "weekly" && schedule.scheduleDay != null) {
    cadenceValue.day = schedule.scheduleDay;
  }
  const nextRunAt = computeOwnerAutomationNextRunAt(schedule, scheduleTime);

  const res = await fetch("/api/automations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({
      title: routineName,
      instruction: title,
      cadence_type: cadenceType,
      cadence_value: cadenceValue,
      next_run_at: nextRunAt,
      timezone,
      assignee_id: null,
      created_by: "carson",
      proof_required: false,
      proof_type: null,
      automation_type: "delegation",
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error ?? "Failed to create automation.");
  }
  const result = await res.json().catch(() => null);

  // A 2xx status is not persistence confirmation by itself — only a response
  // that actually echoes the created automation's id counts as verified
  // persistence. Without this check, an empty/malformed 200 body would still
  // return a success summary for the agent to speak, i.e. a false "done".
  const automationId = result?.automation?.id ?? null;
  if (!automationId) {
    throw new Error("Automation response did not confirm persistence.");
  }

  console.log("[automation:REMINDER_AUTOMATION_CREATED]", {
    automationId,
    title,
  });

  return buildReminderRoutineSummary(title, schedule);
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

// ── Message content extraction ────────────────────────────────────────────────
// Used for automation_type=message automations — strips routing prefix, cadence,
// time expression, and "and tell me/her" connectors to leave only the message body.

function buildMessageRoutingRe(personName: string): RegExp {
  const escaped = personName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Matches: "text Grace", "message Grace", "tell Grace", "send Grace a message"
  return new RegExp(
    `^\\s*(?:text|message|msg|tell)\\s+${escaped}\\b[,\\s]*` +
      `|^\\s*send\\s+${escaped}\\s+a\\s+message\\b[,\\s]*`,
    'i',
  );
}

const TIME_PHRASE_RE = /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi;
const AND_TELL_RE = /\band\s+(?:tell|say(?:\s+to)?)\s+(?:me|her|him|them|us|you)\b[,\s]*/gi;

/**
 * Strips routing prefix ("Text Grace"), cadence language, time expressions,
 * and "and tell her/me" connectors to extract only the message body text.
 *
 * Example:
 *   "Text Sana every day at 5:30 PM and tell me, 'This is a test.'"
 *   → "This is a test."
 */
function extractMessageContent(rawInstruction: string, personName: string): string {
  let msg = rawInstruction;

  // 1. Strip routing prefix ("Text Grace", "Message Loulya", etc.)
  msg = msg.replace(buildMessageRoutingRe(personName), '');

  // 2. Strip cadence language ("every day", "daily", "every morning", etc.)
  msg = msg.replace(RECURRING_CLEAN_RE, '');

  // 3. Strip time expressions ("at 5:30 PM", "at 9 AM")
  msg = msg.replace(TIME_PHRASE_RE, '');

  // 4. Strip "and tell me/her/him" connectors
  msg = msg.replace(AND_TELL_RE, '');

  // 5. Strip surrounding quotes, leading commas/connectors
  msg = msg.replace(/^[,\s"']+|[,\s"']+$/g, '').trim();
  msg = msg.replace(/^(and|that|,)\s+/i, '').trim();

  // 6. Capitalise first letter
  if (msg.length > 0) {
    msg = msg.charAt(0).toUpperCase() + msg.slice(1);
  }

  return msg;
}

/**
 * Builds a structured automation payload from a voice instruction.
 * Returns null when no person is found (e.g. personal message — Phase 2).
 *
 * @param rawInstruction   The cadence-matched source (used for person + time extraction).
 * @param schedule         Detected recurring schedule.
 * @param people           Full people list for person lookup.
 * @param resolvedPerson   Pre-resolved person (sendDelegation already knows them).
 * @param originalInstruction  Full original user utterance — used for automation_type
 *                             detection so a cadence fragment does not strip the trigger word.
 */
export function buildVoiceAutomationInput(
  rawInstruction: string,
  schedule: RecurringSchedule,
  people: Person[],
  resolvedPerson?: Person,
  originalInstruction?: string,
): VoiceAutomationInput | null {
  const person = resolvedPerson ?? findPersonInInstruction(rawInstruction, people);
  if (!person) return null;

  // Detect type from the full original utterance so a cadence-only fragment does not
  // strip the trigger word ("text", "message", "tell") before detection runs.
  const automationType = detectAutomationType(originalInstruction ?? rawInstruction);

  // Message automations extract the message body from the original utterance;
  // delegation automations strip cadence + routing prefix from the cadence source.
  const cleanMessage =
    automationType === 'message'
      ? extractMessageContent(originalInstruction ?? rawInstruction, person.name)
      : extractCleanTaskMessage(rawInstruction, person.name);
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
