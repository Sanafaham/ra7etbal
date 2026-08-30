/**
 * _carson-legacy-tool-result-adapter.js
 *
 * C-03 Structural Response Ownership Project — Slice 2.
 *
 * HONEST LIMITATION, READ FIRST:
 *
 * Client tools execute in the browser (ElevenLabsAgentWidget.tsx, unchanged
 * by this project). Several of them already track a real internal
 * success/failure signal there (lastDirectToolSuccessRef,
 * noteSaveOutcomeRef — see _carson-tool-definitions.js
 * DETERMINISTIC_OUTCOME_TOOLS). But that signal lives only in the browser's
 * in-memory refs today — it is NOT currently transmitted to this backend.
 * ElevenLabs relays only the tool's plain-text return string as the
 * `tool`-role message content.
 *
 * This adapter can therefore only recover a deterministic outcome at the
 * BACKEND boundary for tools whose fixed, code-authored return strings I
 * have directly verified against source in this project (2026-08-31):
 * create_calendar_event, update_calendar_event, delete_calendar_event,
 * save_instruction. These are enumerable constants written by the tool's own
 * code, not free-form model-generated language — matching against them is
 * NOT "inferring success from ambiguous text."
 *
 * For every other DETERMINISTIC_OUTCOME_TOOLS entry (execute_instruction,
 * send_delegation, create_reminder, create_automation, save_note,
 * create_todo, complete_todo, control_task), this adapter conservatively
 * returns "uncertain" AT THIS BOUNDARY, despite the browser knowing better —
 * because the browser's real signal has no path to this backend yet. Closing
 * that gap requires a small, additive change to the client tool wrapper (has
 * it append its already-known outcome as a structured suffix) — out of scope
 * for this slice per "do not rewrite underlying tools unnecessarily";
 * recorded as a named follow-up in the Slice 2 report, not silently assumed.
 */

const CALENDAR_FAILURE_TEXTS = new Set([
  "I need the event title, date, and time before I can add it to your calendar.",
  "I couldn't parse the date. Please say the date clearly and try again.",
  "I couldn't parse the time. Please say the time clearly and try again.",
  "I couldn't add that because Google Calendar needs to be reconnected in Settings to allow event creation.",
  "I need the event title, date, and time before I can add it.",
  "I couldn't add the event to your calendar. Please try again.",
  "Something went wrong. Please try again.",
  "You're not signed in. Please sign in and try again.",
]);

const CALENDAR_UPDATE_FAILURE_TEXTS = new Set([
  "I need the event ID to update it. Please call get_calendar_events first to find the event.",
  "I couldn't parse the date. Please use YYYY-MM-DD format.",
  "I couldn't parse the time. Please use HH:MM 24-hour format.",
  "I need something to change — a new title, date, or time.",
  "Google Calendar needs to be reconnected in Settings.",
  "I couldn't find that event on your calendar. It may have already been deleted.",
  "I couldn't update that event. Please try again.",
  "I couldn't update that event right now. Please try again.",
]);

const CALENDAR_DELETE_FAILURE_PREFIXES = [
  "I need the event ID to delete it.",
  "Google Calendar needs to be reconnected in Settings.",
  "I couldn't delete that event",
];

const SAVE_INSTRUCTION_SUCCESS_TEXT = "Got it. I'll remember that from now on.";
const SAVE_INSTRUCTION_FAILURE_TEXT = "I couldn't save that instruction right now. Please try again.";

/**
 * @param {string} toolName
 * @param {string} text
 * @returns {"success"|"failure"|"uncertain"}
 */
export function classifyLegacyToolText(toolName, text) {
  const value = typeof text === "string" ? text : "";

  if (toolName === "create_calendar_event") {
    if (CALENDAR_FAILURE_TEXTS.has(value)) return "failure";
    // A conflict report is neither success nor failure — it is a pending
    // decision; treat conservatively.
    if (/^Conflict found:/.test(value)) return "uncertain";
    return value ? "success" : "uncertain";
  }

  if (toolName === "update_calendar_event") {
    if (CALENDAR_UPDATE_FAILURE_TEXTS.has(value)) return "failure";
    return value ? "success" : "uncertain";
  }

  if (toolName === "delete_calendar_event") {
    if (CALENDAR_DELETE_FAILURE_PREFIXES.some((prefix) => value.startsWith(prefix))) return "failure";
    return value ? "success" : "uncertain";
  }

  if (toolName === "save_instruction") {
    if (value === SAVE_INSTRUCTION_SUCCESS_TEXT) return "success";
    if (value === SAVE_INSTRUCTION_FAILURE_TEXT) return "failure";
    return "uncertain";
  }

  // Every other tool: no verified backend-side mapping exists yet — stay
  // conservative rather than guess. See module doc comment.
  return "uncertain";
}

export const LEGACY_ADAPTER_COVERED_TOOLS = new Set([
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
  "save_instruction",
]);
