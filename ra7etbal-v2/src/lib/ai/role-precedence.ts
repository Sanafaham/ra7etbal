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

  return items.map((item) => {
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
        suggestedMessage: item.suggestedMessage ?? directRecipient.suggestedMessage,
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
    return (
      (directRecipient.isActionRequest && item.type === "message") ||
      item.type === "reminder" ||
      item.type === "action" ||
      item.type === "followup"
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
  if (isActionRequest) {
    return `Can you please ${lowercaseFirst(clean)}`;
  }
  return `${recipientName}, ${lowercaseFirst(clean)}`;
}

function lowercaseFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
