const SOCIAL_ACKNOWLEDGEMENT_RESPONSES = [
  "You're welcome.",
  "Anytime.",
  "I've got you.",
] as const;

const CARSON_FILLER_PREFIX_PATTERN =
  /^(?:(?:one moment(?:\s+while\s+i[^.?!]*)?|done|got it|of course|hold on|give me a second|just a second|i understand|certainly|absolutely|processing|i(?:'|’)ll analyze(?: that)?|let me(?: check| take a look| look into that)?)[\s.,!?;:—-]*)+/i;

const CARSON_REASONING_PREFIX_PATTERN =
  /^(?:based on (?:your request|the attached (?:photo|image)|the information i have)[\s.,!?;:—-]*|according to (?:your )?(?:ra7etbal|rahet bal)? ?(?:data|context|information)?[\s.,!?;:—-]*|it (?:appears|seems)(?: that)?[\s.,!?;:—-]*|the attached (?:photo|image) (?:shows|is|was)[\s.,!?;:—-]*|the task delegated[\s.,!?;:—-]*)+/i;

const CARSON_IDLE_SENTENCE_PATTERN =
  /(?:^|[.?!]\s*)\b(?:still there|are you there|are you still there)\b[^.?!]*(?:[.?!]|$)/gi;

const CARSON_INTERNAL_SENTENCE_PATTERN =
  /\b(?:photo context was available for this action|do not mention it unless the user asks|(?:analysis|extraction|attachment|prompt|processing|context|transcript|tools|database) (?:was|were|is|are|has|have|will|can|should|available|complete|completed)[^.?!]*(?:[.?!]|$))/gi;

const CARSON_PERMISSION_QUESTION_PATTERN =
  /^(?:would you like me to|do you want me to|should i|shall i)\b[^.?!]*(?:[.?!]|$)/i;

// Chief of Staff behavior policy — Carson must never correct the user's
// wording, name, or pronunciation, or comment on a misheard transcript,
// unless the error actually blocks execution. The model occasionally does
// this anyway (e.g. "Your name is Sana, not Rimaan — I'm Carson"), so this
// is a defense-in-depth sentence-level filter that strips it even if the
// prompt-level instruction is followed imperfectly.
const CARSON_IDENTITY_CORRECTION_SENTENCE_PATTERN =
  /(?:^|[.?!]\s*)\b(?:your name is\b[^.?!]*|i(?:'|’)m carson\b[^.?!]*|i think you meant\b[^.?!]*|you (?:called|referred to) me\b[^.?!]*|that(?:'|’)s not my name\b[^.?!]*)(?:[.?!]|$)/gi;

export function stripIdentityCorrections(text: string): string {
  return text.replace(CARSON_IDENTITY_CORRECTION_SENTENCE_PATTERN, "").replace(/\s+/g, " ").trim();
}

const NETWORK_ERROR_PATTERN = /fetch|network|connection/i;

/**
 * Hides internal failure detail from the user instead of echoing raw error
 * messages (which can contain provider names, status codes, or stack-trace
 * fragments like "Meta", "API", "timeout", "backend"). Never returns the
 * original message text — only one of two fixed, user-facing phrases.
 */
export function sanitizeCarsonErrorDetail(error: unknown): string {
  if (error instanceof TypeError && NETWORK_ERROR_PATTERN.test(error.message)) {
    return "Please check your connection.";
  }
  return "Please try again.";
}

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

  sanitized = sanitized
    .replace(CARSON_IDLE_SENTENCE_PATTERN, "")
    .replace(CARSON_PERMISSION_QUESTION_PATTERN, "")
    .replace(CARSON_INTERNAL_SENTENCE_PATTERN, "")
    .trim();

  return stripIdentityCorrections(sanitized)
    .replace(/\s+([.?!])/g, "$1")
    .replace(/(?:\s*[.?!]){2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

export function shouldSuppressCarsonIdlePrompt(text: string): boolean {
  const sanitized = sanitizeCarsonReplyText(text);
  return !sanitized && text.trim().length > 0;
}

export function sanitizeSocialAcknowledgementReply(text: string): string {
  const withoutFiller = sanitizeCarsonReplyText(text);

  return withoutFiller || "Anytime.";
}
