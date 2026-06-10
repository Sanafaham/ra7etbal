/**
 * Personal-note helpers
 *
 * Used by save.ts (Text Carson) and ElevenLabsAgentWidget.tsx (Voice Carson)
 * to format and inject personal/emotional/status notes into delegation messages.
 *
 * Two exports:
 *   normalizePersonalNote — rewrites raw note into natural recipient-facing language
 *   injectPersonalNote    — inserts the note before the closing sentence of a message
 */

/**
 * Normalize a personal note into natural, recipient-facing language.
 *
 * The raw note may arrive as:
 *   - A bare expression with no subject: "Thank you.", "Hello.", "Miss you."
 *   - An owner-name-prefixed statement: "Sana misses you.", "Sana is on her way."
 *   - A well-formed "says" statement: "Sana says thank you."
 *
 * Rules:
 *   - Bare expression (no subject pronoun or owner name at the start)
 *     → "[Owner] says [expression]."
 *     "Thank you." → "Sana says thank you."
 *     "Hello." → "Sana says hello."
 *
 *   - Owner name as subject, action/emotion verb
 *     → keep as-is, ensure sentence ends with period
 *     "Sana misses you" → "Sana misses you."
 *     "Sana is on her way" → "Sana is on her way."
 *
 *   - Already well-formed "says" statement
 *     → keep as-is
 *     "Sana says thank you." → "Sana says thank you."
 *
 *   - Subject pronoun at start (She/He/They)
 *     → keep as-is, ensure period
 *     "She misses you." → "She misses you."
 */
export function normalizePersonalNote(
  note: string,
  ownerName: string | null | undefined,
): string {
  const raw = note?.trim();
  if (!raw) return raw ?? "";

  const owner = ownerName?.trim() || "They";

  // Strip trailing punctuation for clean rewriting
  const text = raw.replace(/[.!?]+$/, "").trim();
  if (!text) return raw;

  // Check whether the note already has a subject:
  //   - starts with owner name ("Sana ...")
  //   - starts with a pronoun ("She ", "He ", "They ", "I ")
  const subjectPattern = new RegExp(
    `^(${escapeRegex(owner)}|she|he|they|i)\\b`,
    "i",
  );
  const hasSubject = subjectPattern.test(text);

  if (hasSubject) {
    // Well-formed — normalise capitalisation and add period.
    return sentence(text);
  }

  // Bare expression — attach "[Owner] says [expression]."
  const lower = lcFirst(text);
  return sentence(`${owner} says ${lower}`);
}

/**
 * Closing-sentence patterns produced by buildDelegationMessage.
 *
 * These are stripped from the message body before sending because the
 * WhatsApp template already appends "When done, tap here: [link]".
 * Keeping both makes the message repetitive.
 */
const CLOSING_PATTERNS: RegExp[] = [
  /Confirm when (?:done|finished)\./i,
  /Let \w[\w\s]* know when (?:done|finished)\./i,
  /Let \w[\w\s]* know what you find\./i,
  /let me know when it is ready\./i,
  /Stick to the plan[^.]*\./i,
  /Keep to the details[^.]*\./i,
  /Please send \w[\w\s]* a photo before you choose\./i,
  /Please check with \w[\w\s]*before[^.]*\./i,
];

/**
 * Remove the closing confirmation/instruction sentence from a delegation
 * message body.
 *
 * buildDelegationMessage always ends with a sentence like:
 *   "Confirm when done."
 *   "Let Sana know when done."
 *   "Please check with Sana before choosing."
 *
 * The WhatsApp template already appends the confirmation link, so these
 * sentences are redundant and should be stripped from the body.
 *
 * Only the LAST sentence is inspected — the greeting and action request
 * are never modified.
 */
export function stripClosingLine(message: string): string {
  const trimmed = message.trim();
  // Find last sentence boundary (". " or "? ")
  const lastDot = trimmed.lastIndexOf(". ");
  const lastQ = trimmed.lastIndexOf("? ");
  const boundary = Math.max(lastDot, lastQ);
  if (boundary === -1) return trimmed; // single sentence — nothing to strip

  const lastSentence = trimmed.slice(boundary + 2).trim();
  if (CLOSING_PATTERNS.some((p) => p.test(lastSentence))) {
    // Strip the closing sentence; keep everything before the boundary punctuation
    return trimmed.slice(0, boundary + 1).trim();
  }
  return trimmed;
}

/**
 * Inject a personal note at the end of a delegation message body.
 *
 * Call after stripClosingLine so there is no leftover confirmation sentence:
 *
 *   buildDelegationMessage(...)                → "Hi Grace, could you call Sana? Confirm when done."
 *   → stripClosingLine(...)                    → "Hi Grace, could you call Sana?"
 *   → injectPersonalNote(..., "She misses you.") → "Hi Grace, could you call Sana? She misses you."
 *
 * If note is null/empty the stripped message is returned unchanged.
 */
export function injectPersonalNote(
  message: string,
  note: string | null | undefined,
): string {
  if (!note?.trim()) return message;
  return `${message.trimEnd()} ${note.trim()}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

function lcFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
