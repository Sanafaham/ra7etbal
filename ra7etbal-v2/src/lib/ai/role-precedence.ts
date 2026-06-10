import type { ExtractedItem } from "../../types/extraction";
import type { Person } from "../../types/person";

/**
 * Deterministic safety net for the role-precedence rule.
 *
 * Even when the prompt tells the model "Cook + meal = delegation",
 * occasional drift slips through. This pass runs AFTER extraction and
 * promotes obvious misses from `message` to `delegation` so the badge
 * is right and the item ends up in the right tab.
 *
 * We deliberately do NOT rewrite description / suggestedMessage — that
 * would be a heuristic transform and could mangle nuanced wording. The
 * user edits those on the Review screen if the model didn't follow the
 * role-aware translation rules.
 */

interface OperationalRule {
  /** Lowercased role keyword. Match if the person's role contains any of these. */
  role: RegExp;
  /** Topic keywords that must appear (lowercase) in the description for the rule to fire. */
  topic: RegExp;
}

const OPERATIONAL_RULES: OperationalRule[] = [
  // Cook / Chef / Kitchen → meal timing/food
  {
    role: /\b(cook|chef|kitchen)\b/i,
    topic: /\b(dinner|lunch|breakfast|brunch|meal|food|eat|cook|kitchen|menu)\b/i,
  },
  // Driver → transport
  {
    role: /\b(driver|chauffeur)\b/i,
    topic: /\b(pick ?up|drop ?off|drive|car|airport|school run|school|ride|take|fetch|collect)\b/i,
  },
  // Nanny / Babysitter → child-related
  {
    role: /\b(nanny|babysitter|au pair|childminder)\b/i,
    topic: /\b(child|kid|baby|bath|feed|bedtime|nap|school|homework|park|playdate)\b/i,
  },
  // Cleaner / Housekeeper → cleaning
  {
    role: /\b(cleaner|housekeeper|maid)\b/i,
    topic: /\b(clean|laundry|tidy|wash|dust|vacuum|mop|sweep|sheets|towels|bathroom|kitchen)\b/i,
  },
  // PA / Assistant → admin
  {
    role: /\b(personal assistant|executive assistant|\bpa\b|\bea\b|secretary|admin)\b/i,
    topic:
      /\b(book|schedule|reschedule|cancel|order|reserve|invoice|email|document|payment|appointment|flight|hotel|meeting)\b/i,
  },
  // House Manager → coordination
  {
    role: /\b(house manager|estate manager|household manager)\b/i,
    topic: /\b(coordinate|household|staff|schedule|inventory|supplies|maintenance|vendor|repair)\b/i,
  },
  // Gardener → outdoor
  {
    role: /\b(gardener|landscaper)\b/i,
    topic: /\b(garden|plant|lawn|tree|flower|water|trim|prune|mow|outdoor|backyard|patio)\b/i,
  },
  // Tutor → study
  {
    role: /\b(tutor|teacher|coach)\b/i,
    topic: /\b(lesson|homework|study|class|exam|test|tuition|practice|review|essay)\b/i,
  },
];

/** Roles we explicitly treat as relationship-only (won't be auto-promoted). */
const RELATIONSHIP_ROLE_RE =
  /\b(husband|wife|spouse|partner|fianc[eé]e?|mother|father|mom|dad|son|daughter|brother|sister|cousin|aunt|uncle|grand(mother|father|ma|pa)|child|kid|family|friend|neighbor|neighbour|colleague|coworker|boss|manager|business partner|client|customer)\b/i;

export function applyRolePrecedence(
  items: ExtractedItem[],
  people: Person[],
  sourceText = "",
): ExtractedItem[] {
  const byName = new Map<string, Person>();
  for (const p of people) {
    byName.set(p.name.toLowerCase(), p);
  }

  const correctedItems: ExtractedItem[] = items.map((item): ExtractedItem => {
    const directRecipient = getDirectRecipientInstruction(sourceText, people);
    const itemHaystack = `${item.description} ${item.suggestedMessage ?? ""}`.toLowerCase();
    const isLikelyMatchingItem =
      items.length === 1 || itemHaystack.includes(directRecipient?.name.toLowerCase() ?? "");

    if (
      directRecipient &&
      isLikelyMatchingItem &&
      shouldCorrectDirectRecipient(item, directRecipient)
    ) {
      return {
        ...item,
        type: directRecipient.isActionRequest ? "delegation" : "message",
        assignedTo: directRecipient.name,
        // Prefer the deterministically-built message over the AI's version.
        // The AI frequently mangles pronouns (e.g. "text you" instead of
        // "text me") when rewriting the user's instruction for the recipient.
        // The deterministic builder extracts the verb phrase directly from the
        // raw source text, so it avoids that class of error entirely.
        suggestedMessage: directRecipient.suggestedMessage ?? item.suggestedMessage,
        needsPerson: false,
      };
    }

    if (item.type !== "message") return item;
    if (!item.assignedTo || item.assignedTo === "__me__") return item;

    const person = byName.get(item.assignedTo.toLowerCase());
    if (!person) return item;

    // Relationship roles never get auto-promoted.
    if (RELATIONSHIP_ROLE_RE.test(person.role)) return item;

    const haystack = (item.description + " " + (item.suggestedMessage ?? "")).toLowerCase();

    for (const rule of OPERATIONAL_RULES) {
      if (rule.role.test(person.role) && rule.topic.test(haystack)) {
        return { ...item, type: "delegation", needsPerson: false };
      }
    }

    return item;
  });

  return addImpliedOperationalResponsibilities(correctedItems, people, sourceText);
}

export function addImpliedOperationalResponsibilities(
  items: ExtractedItem[],
  people: Person[],
  sourceText: string,
): ExtractedItem[] {
  const impliedDinner = extractDinnerPreparation(sourceText);
  if (!impliedDinner) return items;
  if (hasDinnerPreparation(items)) return items;

  const owner = findOperationalOwner(people, /\b(cook|chef|kitchen)\b/i);
  return [
    ...items,
    {
      id: `implied_dinner_${stableIdPart(impliedDinner.timeLabel)}`,
      type: "delegation",
      description: `Prepare dinner by ${impliedDinner.timeLabel}.`,
      assignedTo: owner?.name ?? "__me__",
      dueAt: null,
      dueText: null,
      suggestedMessage: owner
        ? `Can you please prepare dinner by ${impliedDinner.timeLabel}?`
        : null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
      personalNote: null,
    },
  ];
}

function extractDinnerPreparation(sourceText: string): { timeLabel: string } | null {
  const match = /\bdinner\s+(?:is|starts|will be|begins)\s+(?:at\s+)?(?<time>(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:am|pm|a\.m\.|p\.m\.)?)\b/i.exec(
    sourceText,
  );
  const rawTime = match?.groups?.time?.trim();
  if (!rawTime) return null;

  return { timeLabel: normalizeTimeLabel(rawTime) };
}

function hasDinnerPreparation(items: ExtractedItem[]): boolean {
  return items.some((item) => {
    const haystack = `${item.description} ${item.suggestedMessage ?? ""}`.toLowerCase();
    return (
      /\bdinner\b/.test(haystack) &&
      /\b(prepare|prep|cook|make|ready|serve|have)\b/.test(haystack)
    );
  });
}

function findOperationalOwner(people: Person[], role: RegExp): Person | null {
  return people.find((person) => role.test(person.role)) ?? null;
}

function normalizeTimeLabel(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\ba\.m\.\b/i, "AM")
    .replace(/\bp\.m\.\b/i, "PM")
    .replace(/\bam\b/i, "AM")
    .replace(/\bpm\b/i, "PM")
    .trim();
}

function stableIdPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "task";
}

interface DirectRecipientInstruction {
  name: string;
  isActionRequest: boolean;
  suggestedMessage: string | null;
}

const ACTION_REQUEST_RE =
  /\b(reply|confirm|do|check|prepare|get|buy|bring|call|send|pick\s*up|clean|cook|report back)\b/i;

function getDirectRecipientInstruction(
  sourceText: string,
  people: Person[],
): DirectRecipientInstruction | null {
  const text = sourceText.trim();
  if (!text) return null;
  if (/\bremind\s+me\s+to\s+(tell|ask|remind|have|let|message|send)\b/i.test(text)) {
    return null;
  }

  for (const person of people) {
    const escapedName = escapeRegExp(person.name);
    const patterns = [
      new RegExp(`\\b(tell|ask|remind|have|message|send)\\s+${escapedName}\\b(?<rest>.*)$`, "i"),
      new RegExp(`\\blet\\s+${escapedName}\\s+know\\b(?<rest>.*)$`, "i"),
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      const rest = match?.groups?.rest?.trim() ?? "";
      if (!match) continue;

      const isActionRequest =
        /\bto\s+\w+/i.test(rest) || ACTION_REQUEST_RE.test(rest);

      return {
        name: person.name,
        isActionRequest,
        suggestedMessage: buildDirectRecipientMessage(person.name, rest, isActionRequest),
      };
    }
  }

  return null;
}

function shouldCorrectDirectRecipient(
  item: ExtractedItem,
  directRecipient: DirectRecipientInstruction,
): boolean {
  if (item.assignedTo === directRecipient.name) {
    // Also include delegation so we can replace the AI's broken suggestedMessage
    // with the deterministically-built one (pronoun rewriting, etc.).
    return (
      (directRecipient.isActionRequest && item.type === "message") ||
      item.type === "reminder" ||
      item.type === "action" ||
      item.type === "followup" ||
      item.type === "delegation"
    );
  }

  return !item.assignedTo || item.assignedTo === "__me__";
}

function buildDirectRecipientMessage(
  recipientName: string,
  rest: string,
  isActionRequest: boolean,
): string | null {
  const clean = rest
    .replace(/^\bto\b\s+/i, "")
    .replace(/^\bthat\b\s+/i, "")
    .trim();

  if (!clean) return null;

  // Rewrite third-person pronouns that refer to the recipient into
  // second-person. The user writes from their own perspective ("she lands",
  // "he finishes"); the message must address the recipient directly.
  const rewritten = rewriteRecipientPronouns(clean);

  if (isActionRequest) {
    return `Can you please ${lowercaseFirst(rewritten)}`;
  }
  return `${recipientName}, ${lowercaseFirst(rewritten)}`;
}

/**
 * Convert third-person pronouns referring to the delegate into second-person.
 * First-person references (me, my, myself) are intentionally left untouched —
 * they correctly mean the owner from the recipient's point of view.
 *
 * e.g. "text me when she lands" → "text me when you land"
 *      "send me the doc when he finishes" → "send me the doc when you finish"
 */
function rewriteRecipientPronouns(text: string): string {
  let result = text;

  // "she/he <verb-s/es>" → "you <infinitive>"
  // Handle this before bare pronoun replacement so we can de-conjugate the verb.
  result = result.replace(
    /\b(she|he)\s+([a-zA-Z]+)\b/gi,
    (_match, _pron, verb: string) => `you ${toInfinitive(verb)}`,
  );

  // Reflexives first (before her/him to avoid partial matches)
  result = result
    .replace(/\bherself\b/gi, "yourself")
    .replace(/\bhimself\b/gi, "yourself")
    .replace(/\bthemselves\b/gi, "yourselves");

  // Possessive / object pronouns
  result = result
    .replace(/\bher\b/gi, "your")
    .replace(/\bhim\b/gi, "you")
    .replace(/\btheirs\b/gi, "yours")
    .replace(/\btheir\b/gi, "your")
    .replace(/\bthem\b/gi, "you");

  // Subject pronouns (after object/possessive to avoid double-replacing)
  result = result
    .replace(/\bshe\b/gi, "you")
    .replace(/\bhe\b/gi, "you")
    .replace(/\bthey\b/gi, "you");

  return result;
}

/**
 * Convert a 3rd-person-singular verb form to its base (infinitive) form.
 * Handles the most common regular patterns; irregular verbs fall through
 * to the lookup table.
 *
 * Examples: "lands"→"land", "finishes"→"finish", "arrives"→"arrive",
 *           "carries"→"carry", "has"→"have", "goes"→"go"
 */
const IRREGULAR_INFINITIVE: Record<string, string> = {
  has: "have",
  is: "be",
  goes: "go",
  does: "do",
  says: "say",
  was: "be",
};

function toInfinitive(verb: string): string {
  const lower = verb.toLowerCase();
  if (IRREGULAR_INFINITIVE[lower]) return IRREGULAR_INFINITIVE[lower];

  // -ies → -y  (carries→carry, flies→fly)
  if (lower.endsWith("ies") && lower.length > 4) {
    return lower.slice(0, -3) + "y";
  }
  // consonant-cluster + -es  (finishes→finish, fixes→fix, watches→watch)
  if (/(sh|ch|[xz])es$/.test(lower)) {
    return lower.slice(0, -2);
  }
  // plain -s  (lands→land, calls→call, arrives→arrive, texts→text)
  if (lower.endsWith("s") && lower.length > 2) {
    return lower.slice(0, -1);
  }
  return lower;
}

function lowercaseFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
