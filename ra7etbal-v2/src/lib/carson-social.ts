const SOCIAL_ACKNOWLEDGEMENT_RESPONSES = [
  "You're welcome.",
  "Anytime.",
  "I've got you.",
] as const;

const CARSON_FILLER_PREFIX_PATTERN =
  /^(?:(?:(?:just\s+)?one\s+(?:moment|sec(?:ond)?s?)(?:\s+while\s+i[^.?!]*)?|done|got it|of course|hold on|give me (?:a|one) second|just a second|i understand|certainly|absolutely|processing|i(?:'|’)ll analyze(?: that)?|let me(?: check| take a look| look into that)?)[\s.,!?;:—–-]*)+/i;

const CARSON_REASONING_PREFIX_PATTERN =
  /^(?:based on (?:your request|the attached (?:photo|image)|the information i have)[\s.,!?;:—-]*|according to (?:your )?(?:ra7etbal|rahet bal)? ?(?:data|context|information)?[\s.,!?;:—-]*|it (?:appears|seems)(?: that)?[\s.,!?;:—-]*|the attached (?:photo|image) (?:shows|is|was)[\s.,!?;:—-]*|the task delegated[\s.,!?;:—-]*)+/i;

const CARSON_REENGAGEMENT_PHRASE_PATTERN =
  /\b(?:are you (?:still )?there|still there|are you (?:still )?with me|still with me|just checking(?: in)?|checking in|checking (?:to see )?if you(?:'|’)re (?:still )?there|checking (?:to see )?if you are (?:still )?there|i(?:'|’)m just checking(?: in)?|wanted to check (?:if|whether) you(?:'|’)re (?:still )?there|wanted to check (?:if|whether) you are (?:still )?there|can you hear me|are we still connected)\b/i;

const CARSON_IDLE_SENTENCE_PATTERN =
  /(?:^|[.?!]\s*)\b(?:are you (?:still )?there|still there|are you (?:still )?with me|still with me|just checking(?: in)?|checking in|checking (?:to see )?if you(?:'|’)re (?:still )?there|checking (?:to see )?if you are (?:still )?there|i(?:'|’)m just checking(?: in)?|wanted to check (?:if|whether) you(?:'|’)re (?:still )?there|wanted to check (?:if|whether) you are (?:still )?there|can you hear me|are we still connected)\b[^.?!]*(?:[.?!]|$)/gi;

// Carson must never promise to auto-retry a send — it does not retry, and
// saying so invites the user to expect duplicate WhatsApps. Strip any
// "I'll keep trying" / "I'll try again" / "still trying" sentence so the spoken
// reply reflects the honest one-attempt-then-stop behavior.
const CARSON_RETRY_PROMISE_SENTENCE_PATTERN =
  /(?:^|[.?!]\s*)\b(?:i(?:'|’)?ll keep (?:trying|attempting)|i(?:'|’)?ll try again|i(?:'|’)?ll keep (?:on )?(?:trying|attempting)|let me keep trying|(?:i(?:'|’)?m )?still trying|keep trying)\b[^.?!]*(?:[.?!]|$)/gi;

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

// Live example: a user asked Voice Carson to add a to-do, the action did not
// complete, and the model freelanced a tech-support deflection — "I don't
// have visibility into technical issues with the To-Do feature itself...
// you can report it through the app's support or settings" — instead of a
// plain retry request. This is not a single sentence we can clip and leave a
// coherent remainder behind (the whole reply is built around the deflection),
// so unlike stripIdentityCorrections this replaces the entire reply with a
// clean, honest retry line. Defense-in-depth: catches this regardless of
// whether the dashboard prompt or the model's own improvisation produced it.
const CARSON_TECHNICAL_SUPPORT_DEFLECTION_PATTERN =
  /technical issue|contact support|support team|reach out to (?:support|the team)|visibility into|report (?:it|this) through|rahet bal team|ra7et bal team|the app(?:'|’)s support/i;

export const CARSON_RETRY_FALLBACK_REPLY = "I wasn't able to complete that. Please say it again.";

export function containsTechnicalSupportDeflection(text: string): boolean {
  return CARSON_TECHNICAL_SUPPORT_DEFLECTION_PATTERN.test(text);
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
    .replace(CARSON_RETRY_PROMISE_SENTENCE_PATTERN, "")
    .replace(CARSON_PERMISSION_QUESTION_PATTERN, "")
    .replace(CARSON_INTERNAL_SENTENCE_PATTERN, "")
    .trim();

  sanitized = stripIdentityCorrections(sanitized)
    .replace(/\s+([.?!])/g, "$1")
    .replace(/(?:\s*[.?!]){2,}/g, ".")
    .replace(/\s+/g, " ")
    .trim();

  if (containsTechnicalSupportDeflection(sanitized)) {
    return CARSON_RETRY_FALLBACK_REPLY;
  }

  return sanitized;
}

export function shouldSuppressCarsonIdlePrompt(text: string): boolean {
  const sanitized = sanitizeCarsonReplyText(text);
  return !sanitized && text.trim().length > 0;
}

export function isCarsonReengagementPrompt(text: string): boolean {
  return CARSON_REENGAGEMENT_PHRASE_PATTERN.test(text);
}

export function sanitizeSocialAcknowledgementReply(text: string): string {
  const withoutFiller = sanitizeCarsonReplyText(text);

  return withoutFiller || "Anytime.";
}
