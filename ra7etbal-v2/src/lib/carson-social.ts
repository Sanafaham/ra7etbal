const SOCIAL_ACKNOWLEDGEMENT_RESPONSES = [
  "You're welcome.",
  "Of course.",
  "Anytime.",
] as const;

const CARSON_FILLER_PREFIX_PATTERN =
  /^(?:(?:one moment|got it|hold on|just a second)[\s.,!?;:—-]*)+/i;

const CARSON_IDLE_PROMPT_PATTERN = /\b(?:still there|are you there|are you still there)\b/i;

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

export function sanitizeCarsonReplyText(text: string): string {
  let sanitized = text.trim();
  let previous = "";

  while (sanitized && sanitized !== previous) {
    previous = sanitized;
    sanitized = sanitized.replace(CARSON_FILLER_PREFIX_PATTERN, "").trim();
  }

  return sanitized
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldSuppressCarsonIdlePrompt(text: string): boolean {
  return CARSON_IDLE_PROMPT_PATTERN.test(sanitizeCarsonReplyText(text));
}

export function sanitizeSocialAcknowledgementReply(text: string): string {
  const withoutFiller = sanitizeCarsonReplyText(text);

  return withoutFiller || "Anytime.";
}
