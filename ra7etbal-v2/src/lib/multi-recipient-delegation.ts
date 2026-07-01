import type { Person } from "../types/person";
import type { ExtractedItem } from "../types/extraction";

const MULTI_DELEGATION_PREFIX = /^\s*(?:please\s+)?(?:ask|tell|get|remind)\s+/i;

export function parseMultiRecipientDelegation(
  input: string,
  people: Pick<Person, "name">[],
): ExtractedItem[] | null {
  if (!MULTI_DELEGATION_PREFIX.test(input)) return null;

  const knownPeople = people
    .map((person) => person.name.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (knownPeople.length < 2) return null;

  let rest = input.replace(MULTI_DELEGATION_PREFIX, "").trim();
  const items: ExtractedItem[] = [];

  while (rest) {
    rest = stripLeadingBoundary(rest);
    const person = findPersonAtStart(rest, knownPeople);
    if (!person) break;

    rest = rest.slice(person.length).trim();
    if (!/^to\b/i.test(rest)) return null;
    rest = rest.replace(/^to\b/i, "").trim();

    const boundary = findNextPersonBoundary(rest, knownPeople);
    const action = cleanAction(boundary >= 0 ? rest.slice(0, boundary) : rest);
    if (!action || action.length < 3) return null;

    items.push({
      id: `multi_${items.length}_${person.toLowerCase().replace(/[^a-z0-9]+/gi, "_")}`,
      type: "delegation",
      description: action,
      assignedTo: person,
      dueAt: null,
      dueText: null,
      suggestedMessage: null,
      personalNote: null,
      needsPerson: false,
      needsClarification: false,
      clarificationQuestion: null,
    });

    if (boundary < 0) break;
    rest = rest.slice(boundary);
  }

  return items.length >= 2 ? items : null;
}

function stripLeadingBoundary(text: string): string {
  return text
    .replace(/^\s*[,;]\s*/i, "")
    .replace(/^\s*and\s+/i, "")
    .trim();
}

function findPersonAtStart(text: string, people: string[]): string | null {
  return people.find((name) => {
    const pattern = new RegExp(`^${escapeRegExp(name)}(?:\\b|\\s|,|:|\\.)`, "i");
    return pattern.test(text);
  }) ?? null;
}

function findNextPersonBoundary(text: string, people: string[]): number {
  let best = -1;
  for (const name of people) {
    const pattern = new RegExp(
      `(?:[,;]\\s*(?:and\\s+)?|\\s+and\\s+)${escapeRegExp(name)}\\s+to\\b`,
      "i",
    );
    const match = pattern.exec(text);
    if (!match || match.index == null) continue;
    if (best < 0 || match.index < best) best = match.index;
  }
  return best;
}

function cleanAction(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[,;:\-\s]+|[,;:\-\s]+$/g, "")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
