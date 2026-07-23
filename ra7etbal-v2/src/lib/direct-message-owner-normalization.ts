/**
 * Normalizes owner-relative references in a direct-message body to refer to
 * the message's actual author — the owner — by name, so a staff recipient
 * never reads "me"/"I"/"my" as themselves.
 *
 * Both Talk and Type ultimately compose this body from the owner's own
 * words ("Tell Grace I have no Wi-Fi.", "Ask Grace to call me now.") —
 * without this step the worker receives that first-person text unchanged.
 * Called from the single shared delivery boundary every direct-message path
 * converges on (createDirectMessageRecord, in direct-messages.ts), so the
 * guarantee holds regardless of which channel or fast-path produced the
 * text — see direct-messages.ts and the "Type and Talk parity" tests in
 * carson-protected-behaviors.test.ts.
 *
 * Two deliberately conservative passes, not a blanket "me"/"I"/"my" ->
 * owner substitution:
 *   1. LEADING_SUBJECT_RULES — only the leading subject of the message
 *      ("I'm...", "I have...", "My...") is rewritten. Mid-sentence or
 *      quoted "I"/"my" is left untouched, since the speaker there may not
 *      be the owner.
 *   2. normalizeObjectPronoun — "me" as the object of a small, curated set
 *      of verbs/prepositions ("call me", "wait for me", "bring me the
 *      keys"). An unrelated mid-sentence "me" outside that list is left
 *      untouched.
 *
 * Never invents a gendered pronoun for the owner. The idiom "on my way" is
 * rewritten to the gender-neutral "on the way" rather than guessing "his"
 * or "her".
 */
export function normalizeFirstPersonForOwner(
  messageText: string,
  ownerName: string | null | undefined,
): string {
  const owner = ownerName?.trim();
  if (!owner) return messageText;

  const trimmed = messageText.trim();
  if (!trimmed) return messageText;

  // Leading possessive — no verb to conjugate.
  // "My phone is not working." -> "Sana's phone is not working."
  const possessive = trimmed.match(/^my\s+(.*)$/i);
  if (possessive && possessive[1]) {
    return `${owner}'s ${possessive[1]}`;
  }

  for (const rule of LEADING_SUBJECT_RULES) {
    const match = trimmed.match(rule.pattern);
    if (!match) continue;
    const rest = trimmed.slice(match[0].length);
    if (!rest) return messageText; // nothing follows — avoid producing a sentence fragment
    return composeOwnerSentence(owner, rule.verb, rest);
  }

  // Safety guard (CodeRabbit finding on the PR that introduced
  // normalizeObjectPronoun): a leading "I" that none of the rules above
  // recognized ("I need Grace to call me.") means the owner is still the
  // subject of THIS sentence in a form we don't know how to conjugate.
  // Rewriting only the trailing "me" there would produce mixed-person text
  // ("I need Grace to call Sana.") — leave the whole sentence untouched
  // instead of guessing a conjugation, consistent with this function's
  // conservative-by-design philosophy.
  if (/^i\b/i.test(trimmed)) return messageText;

  // Mid-sentence object pronoun — confirmed production regression: "Ask
  // Grace to call me now." sent Grace the literal text "call me now"; "me"
  // here is the object of "call", not a leading subject, so the rules above
  // never touch it. See normalizeObjectPronoun for the exact, curated
  // pattern list this covers.
  const withObjectPronounNormalized = normalizeObjectPronoun(trimmed, owner);
  if (withObjectPronounNormalized !== trimmed) return withObjectPronounNormalized;

  return messageText;
}

/**
 * Rewrites "me" to the owner's name when it is the direct or indirect
 * object of a small, curated set of verbs/prepositions ("call me", "wait
 * for me", "bring me the keys"). Deliberately a finite list, not a blanket
 * "me" -> owner substitution — an unrelated occurrence of "me" (a different
 * sense, or referring to someone other than the owner) is left untouched.
 * No verb conjugation is needed here, unlike the leading-subject rules
 * above: replacing an object pronoun never changes the sentence's verb form.
 */
const OBJECT_PRONOUN_PATTERNS: RegExp[] = [
  /\b(?:call|contact|reach|text|message|phone|email)\s+me\b/gi,
  /\bwait\s+for\s+me\b/gi,
  /\b(?:bring|get|give|send|hand|pass|fetch|grab)\s+me\b/gi,
];

function normalizeObjectPronoun(text: string, owner: string): string {
  let result = text;
  for (const pattern of OBJECT_PRONOUN_PATTERNS) {
    result = result.replace(pattern, (match) => match.replace(/me$/i, owner));
  }
  return result;
}

interface LeadingSubjectRule {
  pattern: RegExp;
  verb: string;
}

// Checked in order — contractions and explicit auxiliary verbs first, so a
// bare "I " (matched last, only against a recognized irregular verb) never
// shadows a more specific form.
const LEADING_SUBJECT_RULES: LeadingSubjectRule[] = [
  { pattern: /^i['’]m\s+/i, verb: "is" },
  { pattern: /^i am\s+/i, verb: "is" },
  { pattern: /^i['’]ve\s+/i, verb: "has" },
  { pattern: /^i have\s+/i, verb: "has" },
  { pattern: /^i['’]ll\s+/i, verb: "will" },
  { pattern: /^i will\s+/i, verb: "will" },
  { pattern: /^i['’]d\s+/i, verb: "would" },
  { pattern: /^i had\s+/i, verb: "had" },
];

function composeOwnerSentence(owner: string, verb: string, rest: string): string {
  // Known idiom: "on my way" — see file header. Rewritten gender-neutrally
  // rather than guessing a pronoun; every other possessive is handled as
  // "[Owner]'s ..." above.
  const onMyWay = rest.match(/^on my way\b(.*)$/i);
  if (onMyWay) {
    return `${owner} ${verb} on the way${onMyWay[1]}`;
  }
  return `${owner} ${verb} ${rest}`;
}
