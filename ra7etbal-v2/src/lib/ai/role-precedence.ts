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
): ExtractedItem[] {
  const byName = new Map<string, Person>();
  for (const p of people) {
    byName.set(p.name.toLowerCase(), p);
  }

  return items.map((item) => {
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
