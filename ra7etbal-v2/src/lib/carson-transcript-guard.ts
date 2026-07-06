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

function normalizeTranscript(value: string): string {
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
