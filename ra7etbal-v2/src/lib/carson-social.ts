const SOCIAL_ACKNOWLEDGEMENT_RESPONSES = [
  "You're welcome.",
  "Anytime.",
  "I've got you.",
] as const;

const CARSON_FILLER_PREFIX_PATTERN =
  /^(?:(?:one moment|done|got it|of course|hold on|give me a second|just a second|i understand|certainly|absolutely|processing|i(?:'|’)ll analyze(?: that)?|let me(?: check| take a look| look into that)?)[\s.,!?;:—-]*)+/i;

const CARSON_REASONING_PREFIX_PATTERN =
  /^(?:based on (?:your request|the attached (?:photo|image)|the information i have)[\s.,!?;:—-]*|according to (?:your )?(?:ra7etbal|rahet bal)? ?(?:data|context|information)?[\s.,!?;:—-]*|it (?:appears|seems)(?: that)?[\s.,!?;:—-]*|the attached (?:photo|image) (?:shows|is|was)[\s.,!?;:—-]*|the task delegated[\s.,!?;:—-]*)+/i;

const CARSON_IDLE_PROMPT_PATTERN = /\b(?:still there|are you there|are you still there)\b/i;

const CARSON_INTERNAL_SENTENCE_PATTERN =
  /\b(?:photo context was available for this action|do not mention it unless the user asks|(?:analysis|extraction|attachment|prompt|processing|context|transcript|tools|database) (?:was|were|is|are|has|have|will|can|should|available|complete|completed)[^.?!]*(?:[.?!]|$))/gi;

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
    sanitized = sanitized
      .replace(CARSON_FILLER_PREFIX_PATTERN, "")
      .replace(CARSON_REASONING_PREFIX_PATTERN, "")
      .trim();
  }

  return sanitized
    .replace(CARSON_INTERNAL_SENTENCE_PATTERN, "")
    .replace(/\s+([.?!])/g, "$1")
    .replace(/(?:\s*[.?!]){2,}/g, ".")
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
