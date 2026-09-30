/**
 * EVIDENCE ONLY — deterministic Ra7etBal validation of a skill proposal.
 *
 * These guards are bounded mechanical checks justified by known failure
 * evidence. They do NOT prove semantic fidelity; the model evidence gate
 * does. Every guard failure fails CLOSED (no send). Nothing is executed.
 */
import type { Capability, Proposal } from "./skill";

export interface Person {
  name: string;
  aliases: string[];
}

export const OWNER_NAME = "Sana";

/** The owner's people (dry-run fixture — no database). */
export const OWNER_PEOPLE: Person[] = [
  { name: "Christopher", aliases: ["christopher", "كريستوفر"] },
  { name: "Grace", aliases: ["grace", "غريس", "جريس"] },
  { name: "Ghulam", aliases: ["ghulam", "غلام"] },
  { name: "Nasira", aliases: ["nasira", "نصيرة", "نصيره"] },
  { name: "Loulya", aliases: ["loulya", "لوليا"] },
];

/** A person who belongs to a DIFFERENT owner (tenant isolation fixture). */
export const OTHER_OWNER_PEOPLE: Person[] = [{ name: "Maria", aliases: ["maria", "ماريا"] }];

/**
 * Dry-run authorization: the only models this harness lets propose a
 * consequential action are the candidates under evaluation. Production
 * authorization is empty until a model passes its own evidence.
 */
export const EVIDENCE_CANDIDATE_MODELS = ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"] as const;

export type GuardOutcome = "WOULD_SEND" | "HOLD_UNSUPPORTED" | "NO_SEND_CLARIFY" | "NO_SEND_GUARD";

export interface GuardResult {
  outcome: GuardOutcome;
  capability: Capability | null;
  resolvedRecipient: string | null;
  failures: string[];
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ْـ]/g, "") // Arabic diacritics + tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

/** Whole-word match that tolerates common Arabic attached prefixes (و ل ب ف ال). */
function containsWord(haystack: string, word: string): boolean {
  const w = normalizeText(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isArabic = /[؀-ۿ]/.test(w);
  const re = isArabic
    ? new RegExp(`(^|[^\\u0600-\\u06FF])(?:[وفبل]?(?:ال|لل)?)${w}(?=$|[^\\u0600-\\u06FF])`, "u")
    : new RegExp(`(^|[^a-z0-9])${w}(?=$|[^a-z0-9])`);
  return re.test(haystack);
}

export function mentionsPerson(text: string, person: Person): boolean {
  const n = normalizeText(text);
  return person.aliases.some((alias) => containsWord(n, alias));
}

// ── Mechanically preservable constraints ────────────────────────────────
// Closed-class vocabulary (numbers, weekdays, relative days, dayparts),
// canonicalised so "eight", "8" and "الثامنة" compare equal. This is not a
// semantic phrase list: it never decides routing or meaning. Deliberately
// excluded because they are too often not constraints: "one"/"واحد"
// ("the one near…"), "now" ("are now coming"), bare "am" ("I am"), and
// "غدا" (tomorrow) because it collides with "الغدا" (lunch).

const EN_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};
const AR_NUMBERS: Record<string, number> = {
  اثنين: 2, اثنان: 2, ثنتين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4, خمس: 5, خمسه: 5,
  ست: 6, سته: 6, سبع: 7, سبعه: 7, ثمان: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10,
  الواحده: 1, الثانيه: 2, الثالثه: 3, الرابعه: 4, الخامسه: 5, السادسه: 6, السابعه: 7, الثامنه: 8,
  التاسعه: 9, العاشره: 10,
};
const CANONICAL_WORDS: Array<[string, string[]]> = [
  ["DAY:sunday", ["sunday", "الاحد"]],
  ["DAY:monday", ["monday", "الاثنين"]],
  ["DAY:tuesday", ["tuesday", "الثلاثاء"]],
  ["DAY:wednesday", ["wednesday", "الاربعاء"]],
  ["DAY:thursday", ["thursday", "الخميس"]],
  ["DAY:friday", ["friday", "الجمعه"]],
  ["DAY:saturday", ["saturday", "السبت"]],
  ["REL:today", ["today", "اليوم"]],
  ["REL:tonight", ["tonight", "الليله"]],
  ["REL:tomorrow", ["tomorrow", "بكره", "بكرا", "باكر"]],
  ["PART:morning", ["morning", "الصبح", "صباحا", "الصباح"]],
  ["PART:afternoon", ["afternoon", "العصر"]],
  ["PART:evening", ["evening", "المسا", "مساء", "المساء"]],
  ["PART:noon", ["noon", "الظهر"]],
];

export function extractConstraints(text: string): Set<string> {
  const n = normalizeText(text);
  const out = new Set<string>();
  // Clock times: "7:30" → 7 and 30; ":00" adds nothing.
  const withoutClock = n.replace(/(\d{1,2}):(\d{2})/g, (_m, h: string, m: string) => {
    out.add(`NUM:${Number(h)}`);
    if (Number(m) !== 0) out.add(`NUM:${Number(m)}`);
    return " ";
  });
  for (const m of withoutClock.matchAll(/\d+/g)) out.add(`NUM:${Number(m[0])}`);
  for (const [word, value] of Object.entries(EN_NUMBERS)) if (containsWord(n, word)) out.add(`NUM:${value}`);
  // Weekday "الاثنين" (Monday) must not also count as "اثنين" (two).
  const arNumberText = n.replace(/(^|\s)[وفبل]?الاثنين(?=\s|$)/g, " ");
  for (const [word, value] of Object.entries(AR_NUMBERS)) if (containsWord(arNumberText, word)) out.add(`NUM:${value}`);
  for (const [canonical, words] of CANONICAL_WORDS) if (words.some((w) => containsWord(n, w))) out.add(canonical);
  // am/pm only directly after a number ("I am" is not a time).
  if (/\d\s*(am|a\.m\.)(?=$|[^a-z])/.test(n)) out.add("PART:am");
  if (/\d\s*(pm|p\.m\.)(?=$|[^a-z])/.test(n)) out.add("PART:pm");
  return out;
}

function resolvePerson(ref: string, people: Person[]): Person[] {
  const n = normalizeText(ref.trim());
  return people.filter((p) => p.aliases.some((a) => normalizeText(a) === n) || normalizeText(p.name) === n);
}

export function validateProposal(args: {
  proposal: unknown;
  utterance: string;
  requestedModel: string;
  producingModel: string | undefined;
}): GuardResult {
  const failures: string[] = [];
  const { utterance, requestedModel, producingModel } = args;

  // G1 — model/provider authorization (no silent substitution).
  if (!(EVIDENCE_CANDIDATE_MODELS as readonly string[]).includes(requestedModel)) failures.push("G1_model_not_authorized");
  if (!producingModel || !producingModel.startsWith(requestedModel)) failures.push("G1_producing_model_mismatch");

  // G2 — required fields / schema.
  const p = args.proposal as Partial<Proposal> | null;
  const capability = p && typeof p === "object" ? p.capability : undefined;
  if (capability !== "tracked_delegation" && capability !== "direct_communication" && capability !== "no_action") {
    return { outcome: "NO_SEND_GUARD", capability: null, resolvedRecipient: null, failures: [...failures, "G2_malformed_capability"] };
  }
  const proposal = p as Proposal;
  if (typeof proposal.report_back_to_owner !== "boolean") failures.push("G2_malformed_report_back");

  if (capability === "no_action") {
    if (!proposal.reason || !proposal.reason.trim()) failures.push("G2_no_action_without_reason");
    return { outcome: failures.length ? "NO_SEND_GUARD" : "NO_SEND_CLARIFY", capability, resolvedRecipient: null, failures };
  }

  const message = typeof proposal.recipient_message === "string" ? proposal.recipient_message.trim() : "";
  const unsupported = typeof proposal.unsupported_carson_request === "string" ? proposal.unsupported_carson_request.trim() : "";
  if (!proposal.recipient || !proposal.recipient.trim()) failures.push("G2_missing_recipient");
  if (!message) failures.push("G2_missing_recipient_message");

  // G3 — recipient resolves to exactly one of THIS owner's people and is grounded in the owner's words.
  let resolved: Person | null = null;
  if (proposal.recipient) {
    const matches = resolvePerson(proposal.recipient, OWNER_PEOPLE);
    if (matches.length !== 1) failures.push("G3_recipient_not_exactly_one_owner_person");
    else {
      resolved = matches[0];
      if (!mentionsPerson(utterance, resolved)) failures.push("G3_recipient_not_named_by_owner");
    }
  }

  // G4 — no invented known person; G5 — named people not silently lost.
  const knownPeople = [...OWNER_PEOPLE, ...OTHER_OWNER_PEOPLE];
  for (const person of knownPeople) {
    if (resolved && person.name === resolved.name) continue;
    const inUtterance = mentionsPerson(utterance, person);
    const inMessage = mentionsPerson(message, person);
    if (inMessage && !inUtterance) failures.push(`G4_invented_person:${person.name}`);
    if (inUtterance && !inMessage && !mentionsPerson(unsupported, person)) failures.push(`G5_person_lost:${person.name}`);
  }

  // G6 — numbers/times/dates not lost or invented.
  const owner = extractConstraints(utterance);
  const carried = new Set([...extractConstraints(message), ...extractConstraints(unsupported)]);
  for (const c of owner) if (!carried.has(c)) failures.push(`G6_constraint_lost:${c}`);
  for (const c of extractConstraints(message)) if (!owner.has(c)) failures.push(`G6_constraint_invented:${c}`);

  // G7 — lifecycle semantics: direct communication cannot carry tracked semantics.
  if (capability === "direct_communication" && proposal.report_back_to_owner === true) failures.push("G7_direct_with_tracked_semantics");

  if (failures.length) return { outcome: "NO_SEND_GUARD", capability, resolvedRecipient: resolved?.name ?? null, failures };

  // G8 — materially connected unsupported Carson work holds the WHOLE action.
  if (unsupported) return { outcome: "HOLD_UNSUPPORTED", capability, resolvedRecipient: resolved?.name ?? null, failures: ["G8_unsupported_carson_request"] };

  return { outcome: "WOULD_SEND", capability, resolvedRecipient: resolved?.name ?? null, failures: [] };
}
