/**
 * typed-advisory-redirect.ts
 *
 * Type to Carson is advisory-only (RA7ETBAL_STATE.md, 2026-07-25). Hosting,
 * staff direct-message, and delegation execution requests already have
 * dedicated pre-model detectors and advisory redirects in
 * ElevenLabsAgentWidget.tsx (resolveGuestOutcomeAction, parseSimpleDirectMessage,
 * parseDelegationFastPath). This module covers the requests those detectors
 * cannot see:
 *
 *  - reminder / calendar requests, which have no pre-model detector at all
 *    today (they rely entirely on the free-form model choosing a tool, which
 *    is blocked only after the fact)
 *  - a bodyless staff address ("Tell Grace.", "Send this to Christopher.")
 *    that the message-body parsers correctly return null for (no extractable
 *    message content), but which is still clearly an instruction to contact
 *    someone
 *  - other bare imperative action requests ("Take care of it.", "Pay the
 *    electricity bill.", "Book this.", "Assign this.", "Create a to-do.")
 *
 * Every pattern is anchored to the START of the (trimmed) message, mirroring
 * how parseSimpleDirectMessage/parseDelegationFastPath already anchor on
 * "please ask/tell/get" — a message that merely uses one of these words later
 * in an advisory or brain-dump sentence ("I need to think about how to
 * handle...") must not be misread as an execution request.
 *
 * The staff-address check validates the addressed word against the real
 * People list (matching direct-message-fast-path.ts's own convention) rather
 * than a capitalization heuristic — a naive `[A-Z]` check is silently
 * defeated by the case-insensitive `/i` flag every other pattern here needs,
 * and would otherwise misclassify "Tell me what you think." or "Ask yourself
 * why this keeps happening." as staff messages.
 */

import type { Person } from "../types/person";

export type TypedExecutionCategory =
  | "reminder"
  | "calendar"
  | "staff_message"
  | "generic_action";

export interface TypedExecutionRedirect {
  category: TypedExecutionCategory;
  message: string;
}

const TYPED_REMINDER_RE = /\bremind me\b|\bset (?:a |the )?reminder\b|\breminder for\b/i;

const TYPED_CALENDAR_RE = /\b(?:add|put|schedule)\b.{0,40}\bcalendar\b/i;

// A bodyless address to a named person — "Tell Grace.", "Send this to
// Christopher." — that parseSimpleDirectMessage correctly returns null for
// (no extractable message content) but is still clearly staff communication.
// Captures the candidate name word; matchesKnownPerson below validates it.
const TYPED_STAFF_ADDRESS_RE =
  /^\s*(?:please\s+)?(?:tell|ask|message|text|call)\s+([a-zA-Z'-]+)\b/i;
const TYPED_SEND_TO_RE = /\bsend\s+(?:this|it|that)\s+to\s+([a-zA-Z'-]+)\b/i;

// Anchored imperative action verbs with no dedicated detector of their own.
// "book" and "pay" are narrowed against confirmed false positives ("Book
// club is...", "Pay attention to...") that a bare anchored verb would
// otherwise catch; the others are safe unrestricted because starting a
// message with them is already a strong, low-false-positive imperative
// signal on its own.
const TYPED_GENERIC_ACTION_RE =
  /^\s*(?:please\s+)?(?:handle|take care of|arrange|book\s+(?:it|this|that)\b|assign|sort out|pay\b(?!\s+attention\b)|create (?:a|the) to-?do|add (?:a|the) to-?do)/i;

const REDIRECT_MESSAGES: Record<TypedExecutionCategory, string> = {
  reminder: "Use Talk to Carson to create the reminder.",
  calendar: "Use Talk to Carson to add it to your calendar.",
  staff_message: "Use Talk to Carson to send the message.",
  generic_action: "Use Talk to Carson to handle that.",
};

function matchesKnownPerson(candidate: string | undefined, people: Person[]): boolean {
  const normalized = candidate?.trim().toLowerCase();
  if (!normalized) return false;
  return people.some((person) => person.name?.trim().toLowerCase() === normalized);
}

/**
 * Classifies a typed message as an execution request not already covered by
 * a dedicated detector, or returns null when it reads as a question,
 * planning help, a brain dump, or other advisory-safe request.
 */
export function classifyTypedExecutionRequest(
  text: string,
  people: Person[],
): TypedExecutionRedirect | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (TYPED_REMINDER_RE.test(trimmed)) {
    return { category: "reminder", message: REDIRECT_MESSAGES.reminder };
  }
  if (TYPED_CALENDAR_RE.test(trimmed)) {
    return { category: "calendar", message: REDIRECT_MESSAGES.calendar };
  }
  const staffAddressMatch = trimmed.match(TYPED_STAFF_ADDRESS_RE);
  if (staffAddressMatch && matchesKnownPerson(staffAddressMatch[1], people)) {
    return { category: "staff_message", message: REDIRECT_MESSAGES.staff_message };
  }
  const sendToMatch = trimmed.match(TYPED_SEND_TO_RE);
  if (sendToMatch && matchesKnownPerson(sendToMatch[1], people)) {
    return { category: "staff_message", message: REDIRECT_MESSAGES.staff_message };
  }
  if (TYPED_GENERIC_ACTION_RE.test(trimmed)) {
    return { category: "generic_action", message: REDIRECT_MESSAGES.generic_action };
  }
  return null;
}
