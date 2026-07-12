export const CARSON_REPEAT_PROMPT = "I didn't catch that. Please say it again.";

export type CarsonTranscriptGuardReason =
  | "empty"
  | "punctuation_only"
  | "ellipsis"
  | "clipped_call_fragment";

export interface CarsonTranscriptGuardResult {
  valid: boolean;
  reason: CarsonTranscriptGuardReason | null;
}

export function normalizeTranscript(value: string): string {
  return value
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function evaluateCarsonTranscriptCapture(
  transcript: string | null | undefined,
): CarsonTranscriptGuardResult {
  const normalized = normalizeTranscript(transcript ?? "");
  if (!normalized) return { valid: false, reason: "empty" };

  const punctuationOnly = normalized.replace(/[.,!?;:'"`~\-_()[\]{}…\s]/g, "");
  if (!punctuationOnly) {
    return normalized.includes(".") || normalized.includes("…")
      ? { valid: false, reason: "ellipsis" }
      : { valid: false, reason: "punctuation_only" };
  }

  const words = normalized.match(/[A-Za-z0-9']+/g) ?? [];
  const lower = normalized.toLowerCase();
  if (
    words.length <= 2 &&
    /\b(call|phone|ring)\s+me\b/.test(lower)
  ) {
    return { valid: false, reason: "clipped_call_fragment" };
  }

  return { valid: true, reason: null };
}

// Confirmed production bug: a valid, clearly-heard closing/social phrase
// ("Thank you.") ended up with the LLM calling a tool with no real
// instruction content, and the tool-side capture guard then answered with
// CARSON_REPEAT_PROMPT ("I didn't catch that...") — misleading, since the
// transcript WAS heard correctly; there was simply nothing to act on.
// Distinct from CONFIRMATION_RE/REJECTION_RE in ops-intelligence.ts, which
// mean "yes/no, proceed with the pending action" — these phrases carry no
// actionable intent at all, so a short natural reply is the honest answer,
// not a re-prompt. Deliberately narrow (exact short phrases only) so this
// never weakens evaluateCarsonTranscriptCapture's noise/garble protection.
const THANKS_RE = /^(thank(s| you)( so much| very much| a lot)?)[.!]?$/i;
const GOODNIGHT_RE = /^(good\s*night|goodnight|bye|goodbye|see you)[.!]?$/i;
const CLOSING_RE =
  /^(no,?\s*that('s| is) all|that('s| is) all|got it|okay|ok|alright|all right|sounds good)[.!]?$/i;

/**
 * Returns a brief natural reply for a short social/closing phrase that
 * carries no actionable instruction (e.g. "Thank you.", "Okay.", "Good
 * night."), or null if the text doesn't match one of those phrases.
 */
export function matchCarsonSocialAcknowledgment(
  text: string | null | undefined,
): string | null {
  const normalized = normalizeTranscript(text ?? "");
  if (!normalized) return null;
  if (THANKS_RE.test(normalized)) return "You're welcome!";
  if (GOODNIGHT_RE.test(normalized)) return "Good night!";
  if (CLOSING_RE.test(normalized)) return "Got it.";
  return null;
}
