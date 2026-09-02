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
//
// 2026-09-01 owner canary: "What am I waiting on?" (this file's original
// coverage) requires that exact word order and missed the real phrasing
// Sana actually used — "What about the things I'm waiting on?". Neither
// this pattern nor ATTENTION_FOLLOWUP_PATTERN matched it, so
// attentionIntentDetected was false for that turn: no grounding fetch ran,
// and resolveAttentionGuardedMessage's override never fired (it's a no-op
// when attentionIntentDetected is false — see carson-attention-intent-
// guard.ts) for EITHER surface, typed or voice. Voice's underlying model
// then independently re-invoked get_task_delivery_status and composed a
// reply from that unrelated data ("that's the one loop still waiting on
// someone") that contradicted typed's separately-composed answer for the
// exact same live state ("you're not currently waiting on anyone") —
// diverging because neither answer was ever forced to the one canonical
// attention_summary_read result, not because the underlying classifiers
// disagreed. Adding a "waiting on" question-shape alternative here closes
// that gap for both surfaces identically going forward.
const ATTENTION_INTENT_PATTERN =
  /\b(?:what needs my attention|what('?s| is) pending|what am i waiting on|what(?:'s| is)?(?: about)?(?: the things?)? (?:i'?m |i am )?waiting on|anything (?:i'?m |i am )?waiting on|what('?s| is) on my plate|am i clear|what('?s| is) outstanding|anything pending)\b/i;

// Only meaningful as a continuation of an attention exchange — the caller
// gates this on the immediately preceding turn having been a grounded
// attention answer. Never treated as attention-scoped on its own.
const ATTENTION_FOLLOWUP_PATTERN =
  /^\s*(?:what else|anything else|is that everything|what else is pending)\s*\??\s*$/i;

export function matchesAttentionIntent(utterance) {
  return ATTENTION_INTENT_PATTERN.test(utterance);
}

// Extracted (2026-09-02, live isolated canary) from the SAME sub-pattern
// already inside ATTENTION_INTENT_PATTERN above — not a new/duplicated
// phrase list. Lets a caller distinguish "this utterance specifically asks
// about the Waiting category" from the broader "this is attention-class at
// all" check, so a follow-up this unambiguous can be answered
// deterministically (evidence.waiting, already structured and already
// authorized) instead of via an LLM reasoning call whose only job for this
// exact case would be to notice the word "waiting" and select the same
// items a plain category filter already identifies exactly. Genuinely
// ambiguous follow-ups (reference resolution, ranking, contrast, deferral
// timing) are NOT covered by this and still go through reasoning — see
// api/_carson-read-turn.js's coordinateAttentionTurn.
const ATTENTION_WAITING_FOLLOWUP_PATTERN =
  /\b(?:what am i waiting on|what(?:'s| is)?(?: about)?(?: the things?)? (?:i'?m |i am )?waiting on|anything (?:i'?m |i am )?waiting on)\b/i;

export function matchesWaitingFollowUp(utterance) {
  return ATTENTION_WAITING_FOLLOWUP_PATTERN.test(utterance);
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
