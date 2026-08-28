/**
 * Server/browser-safe attention-intent classification.
 *
 * PURE RELOCATION from src/lib/carson-attention-intent-guard.ts (2026-08-28,
 * Second Brain typed hard-grounding slice) — no behavior change. Same
 * classification must decide whether a turn needs live grounding whether
 * it's evaluated client-side (voice/typed guard) or server-side (the typed
 * hard-grounding boundary) — one source of truth for "is this an
 * attention-class question."
 */

// Matches the exact trigger phrases ATTENTION SUMMARY / DAILY BRIEF AND
// STATUS already define, plus the close variants named in the 2026-08-25
// investigation ("what's on my plate", "am I clear").
const ATTENTION_INTENT_PATTERN =
  /\b(?:what needs my attention|what('?s| is) pending|what am i waiting on|what('?s| is) on my plate|am i clear|what('?s| is) outstanding|anything pending)\b/i;

// Only meaningful as a continuation of an attention exchange — the caller
// gates this on the immediately preceding turn having been a grounded
// attention answer. Never treated as attention-scoped on its own.
const ATTENTION_FOLLOWUP_PATTERN =
  /^\s*(?:what else|anything else|is that everything|what else is pending)\s*\??\s*$/i;

export function matchesAttentionIntent(utterance) {
  return ATTENTION_INTENT_PATTERN.test(utterance);
}

export function matchesAttentionFollowUp(utterance) {
  return ATTENTION_FOLLOWUP_PATTERN.test(utterance);
}

/**
 * Reuses carson-operations-center.ts's own fetchAttentionSummary()
 * total-failure phrasing for consistency — this is the same honest
 * "couldn't check" contract the tool itself already uses, not new copy
 * invented here.
 */
export const ATTENTION_GROUNDING_UNAVAILABLE_MESSAGE =
  "I couldn't check what needs your attention right now — the live check didn't complete.";
