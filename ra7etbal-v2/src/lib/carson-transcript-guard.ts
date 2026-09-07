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
//
// Second confirmed production bug: "Thank you. Look." was still answered
// with CARSON_REPEAT_PROMPT, because these were originally full-string
// anchored (^...$) — an acknowledgment followed by ANY trailing speech,
// however harmless, failed to match. These are now LEAD patterns (matched
// only at the start): if the acknowledgment is the whole utterance, or is
// followed only by a short, non-actionable conversational fragment ("Look.",
// "Yeah."), it's still treated as a genuinely-heard, non-actionable turn. If
// the trailing remainder itself reads as an actionable request (contains a
// request-shaped cue word or a question mark, or is simply long), this
// deliberately returns null instead — the real instruction must still reach
// normal instruction handling, never get silently swallowed by a "thanks".
const THANKS_LEAD_RE = /^(thank(s| you)( so much| very much| a lot)?)[.!]?\s*/i;
const GOODNIGHT_LEAD_RE = /^(good\s*night|goodnight|bye|goodbye|see you)[.!]?\s*/i;
const CLOSING_LEAD_RE =
  /^(no,?\s*that('s| is) all|that('s| is) all|got it|okay|ok|alright|all right|sounds good)[.!]?\s*/i;

const ACTIONABLE_REMAINDER_RE =
  /\?|\b(please|can you|could you|would you|remind|reminder|call|phone|text|message|whatsapp|send|tell|ask|schedule|book|appointment|calendar|meeting|buy|order|cancel|delete|remove|add|create|note|remember|todo|task|delegate|email)\b/i;

const SOCIAL_ACKNOWLEDGMENT_LEADS: Array<[RegExp, string]> = [
  [THANKS_LEAD_RE, "You're welcome!"],
  [GOODNIGHT_LEAD_RE, "Good night!"],
  [CLOSING_LEAD_RE, "Got it."],
];

/**
 * Returns a brief natural reply for a short social/closing phrase that
 * carries no actionable instruction (e.g. "Thank you.", "Okay.", "Good
 * night." — including one immediately followed by a short, harmless
 * conversational fragment such as "Thank you. Look."), or null if the text
 * doesn't match one of those phrases, or a real request follows it.
 */
export function matchCarsonSocialAcknowledgment(
  text: string | null | undefined,
): string | null {
  const normalized = normalizeTranscript(text ?? "");
  if (!normalized) return null;

  for (const [leadPattern, reply] of SOCIAL_ACKNOWLEDGMENT_LEADS) {
    const match = normalized.match(leadPattern);
    if (!match) continue;

    const remainder = normalized.slice(match[0].length).trim();
    if (!remainder) return reply;

    const remainderWordCount = (remainder.match(/[A-Za-z0-9']+/g) ?? []).length;
    const looksActionable =
      remainderWordCount > 4 || ACTIONABLE_REMAINDER_RE.test(remainder);
    return looksActionable ? null : reply;
  }

  return null;
}
