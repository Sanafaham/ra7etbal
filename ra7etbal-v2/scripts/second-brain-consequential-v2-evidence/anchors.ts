/**
 * EVIDENCE ONLY — material-anchor helpers for the V2 gate.
 *
 * Two different uses, kept separate on purpose:
 *
 * 1. RUNTIME-SHAPED closed-vocabulary checks (people, numbers, clock times,
 *    weekdays, relative days, day-parts). Carried over unchanged in behavior
 *    from the frozen v1 harness guards G4–G6. They never decide routing or
 *    meaning; they only catch a lost or invented name/number/day.
 *
 * 2. EVALUATION-ONLY frozen anchors (quantities, dates, times, locations,
 *    conditions) written per case in the frozen corpus. Checking them at
 *    runtime would need phrase matching, which the V2 contract forbids, so they
 *    are used only by the evidence grader to flag runs for hand review.
 */

export interface Person {
  name: string;
  aliases: string[];
  relationship: "staff" | "family";
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
export function containsWord(haystack: string, word: string): boolean {
  const n = normalizeText(haystack);
  const w = normalizeText(word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isArabic = /[؀-ۿ]/.test(w);
  const re = isArabic
    ? new RegExp(`(^|[^\\u0600-\\u06FF])(?:[وفبل]?(?:ال|لل)?)${w}(?=$|[^\\u0600-\\u06FF])`, "u")
    : new RegExp(`(^|[^a-z0-9])${w}(?=$|[^a-z0-9])`);
  return re.test(n);
}

export function mentionsPerson(text: string, person: Person): boolean {
  return person.aliases.some((alias) => containsWord(text, alias));
}

// Closed-class vocabulary. Deliberately excluded because they are too often
// not constraints: "one"/"واحد", "now", bare "am", and "غدا" (collides with
// "الغدا", lunch). Identical to the frozen v1 guard vocabulary.
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
  const withoutClock = n.replace(/(\d{1,2}):(\d{2})/g, (_m, h: string, m: string) => {
    out.add(`NUM:${Number(h)}`);
    if (Number(m) !== 0) out.add(`NUM:${Number(m)}`);
    return " ";
  });
  for (const m of withoutClock.matchAll(/\d+/g)) out.add(`NUM:${Number(m[0])}`);
  for (const [word, value] of Object.entries(EN_NUMBERS)) if (containsWord(n, word)) out.add(`NUM:${value}`);
  const arNumberText = n.replace(/(^|\s)[وفبل]?الاثنين(?=\s|$)/g, " ");
  for (const [word, value] of Object.entries(AR_NUMBERS)) if (containsWord(arNumberText, word)) out.add(`NUM:${value}`);
  for (const [canonical, words] of CANONICAL_WORDS) if (words.some((w) => containsWord(n, w))) out.add(canonical);
  if (/\d\s*(am|a\.m\.)(?=$|[^a-z])/.test(n)) out.add("PART:am");
  if (/\d\s*(pm|p\.m\.)(?=$|[^a-z])/.test(n)) out.add("PART:pm");
  return out;
}

/** Frozen evaluation anchor: satisfied when any alternative appears (normalized substring). */
export interface FrozenAnchor {
  type: "person" | "quantity" | "date" | "time" | "location" | "condition";
  any: string[];
}

export function missingFrozenAnchors(text: string, anchors: FrozenAnchor[]): FrozenAnchor[] {
  const n = normalizeText(text);
  return anchors.filter((a) => !a.any.some((alt) => n.includes(normalizeText(alt))));
}
