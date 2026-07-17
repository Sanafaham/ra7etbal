/**
 * Normalizes a leading first-person subject in a direct-message body to
 * refer to the message's actual author — the owner — by name.
 *
 * Voice Carson's outbound direct messages are composed by the ElevenLabs
 * model itself, which naturally writes "Sana has no Wi-Fi." on the owner's
 * behalf. Typed Carson's fast path (direct-message-fast-path.ts) extracts
 * the message body verbatim from the owner's own words — "Tell Grace I
 * have no Wi-Fi." — so without this step, the worker receives the raw
 * first-person text unchanged ("I have no Wi-Fi."). This function is the
 * single place that reconciles the two: called after parsing, before the
 * WhatsApp send, only on the typed path (see direct-message-fast-path.ts).
 *
 * Deliberately conservative — only the LEADING subject of the message is
 * rewritten. Mid-sentence or quoted "I"/"my" is left untouched, since the
 * speaker there may not be the owner and rewriting it could change the
 * message's meaning.
 *
 * Does not invent a gendered pronoun for the owner. The one exception is
 * the fixed idiom "on my way", which this codebase already renders as
 * "on her way" elsewhere (see personal-note.ts) — reusing that existing,
 * established phrasing rather than introducing a new pronoun rule.
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

  return messageText;
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
  // Known idiom: "on my way" — see file header. Only this exact phrase gets
  // a pronoun; every other possessive is handled as "[Owner]'s ..." above.
  const onMyWay = rest.match(/^on my way\b(.*)$/i);
  if (onMyWay) {
    return `${owner} ${verb} on her way${onMyWay[1]}`;
  }
  return `${owner} ${verb} ${rest}`;
}
