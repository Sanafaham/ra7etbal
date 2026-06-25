const SOCIAL_ACKNOWLEDGEMENT_RESPONSES = [
  "You're welcome.",
  "Of course.",
  "Anytime.",
] as const;

const SOCIAL_REPLY_FILLER_PATTERN = /\b(?:one moment|got it|hold on)\b[\s.,!?;:—-]*/gi;

function normalizeSocialText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:()[\]{}"'“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSocialAcknowledgement(text: string): boolean {
  const normalized = normalizeSocialText(text);
  if (!normalized) return false;

  return /^(?:(?:ok|okay|perfect|great|cool|alright|all right)\s+)?(?:thank you|thanks)(?:\s+(?:carson|so much|a lot))?$/.test(
    normalized,
  );
}

export function getSocialAcknowledgementReply(text: string): string {
  const normalized = normalizeSocialText(text);
  const index = normalized.length % SOCIAL_ACKNOWLEDGEMENT_RESPONSES.length;
  return SOCIAL_ACKNOWLEDGEMENT_RESPONSES[index] ?? "You're welcome.";
}

export function sanitizeSocialAcknowledgementReply(text: string): string {
  const withoutFiller = text
    .replace(SOCIAL_REPLY_FILLER_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();

  return withoutFiller || "Anytime.";
}
