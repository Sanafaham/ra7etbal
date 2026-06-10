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
 * Inject a personal note before the closing sentence of a delegation message.
 *
 * buildDelegationMessage produces: "[greeting+action sentence]. [closing sentence]."
 *
 * Result: "[greeting+action sentence]. [note] [closing sentence]."
 *
 * Examples:
 *   "Hi Grace, could you call Sana? Confirm when done."
 *   + "She misses you."
 *   → "Hi Grace, could you call Sana? She misses you. Confirm when done."
 *
 *   "Hi Grace, could you wait for Sana? Let Sana know when done."
 *   + "Sana is on her way."
 *   → "Hi Grace, could you wait for Sana? Sana is on her way. Let Sana know when done."
 *
 * Falls back to appending the note at the end for single-sentence messages.
 */
export function injectPersonalNote(
  message: string,
  note: string | null | undefined,
): string {
  if (!note?.trim()) return message;
  const n = note.trim();
  // Split at last sentence boundary: find last ". " or "? " that has text after it.
  const match = /^([\s\S]*[.?!])\s+([^.?!\s][^.?!]*[.?!]?\s*)$/.exec(message);
  if (match) {
    return `${match[1]} ${n} ${match[2].trim()}`.trimEnd();
  }
  // Single-sentence or no match — append at end.
  return `${message} ${n}`;
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
