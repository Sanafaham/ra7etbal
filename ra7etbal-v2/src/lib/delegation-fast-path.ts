import type { Person } from "../types/person";

export type DelegationFastPathResult =
  | { handled: false; reason: "no_match" }
  | {
      handled: true;
      status: "sent" | "blocked" | "failed";
      response: string;
      personName?: string;
      taskText?: string;
      reason?: "missing_phone" | "missing_consent" | "send_failed";
    };

interface DelegationFastPathContext {
  people: Person[];
  userId: string;
  displayName?: string | null;
}

interface DelegationFastPathDeps {
  sendDelegationFn: (params: { name: string; task: string }) => Promise<string>;
}

export interface ParsedDelegation {
  personName: string;
  taskText: string;
}

// Personal note indicators — "and tell her I miss her" needs Anthropic for note composition.
const HAS_PERSONAL_NOTE = /\band\s+(?:tell|say|inform)\s+(?:him|her|them)\b/i;
// Multi-person conjunctions — "and ask/tell/have Grace" means multiple recipients.
const HAS_MULTI_PERSON = /\b(?:and|also)\s+(?:ask|tell|have|get)\b/i;

/**
 * Parses simple single-person delegation patterns from a raw instruction.
 * Returns null if the instruction is complex, ambiguous, or multi-person.
 *
 * Supported patterns:
 *   ask/tell/get [name] to [task]   — 1–2 word name
 *   have [name] [task]              — 1-word name (avoids greedy word-boundary ambiguity)
 */
export function parseDelegationFastPath(
  instruction: string,
  people: Person[],
): ParsedDelegation | null {
  if (HAS_PERSONAL_NOTE.test(instruction)) return null;
  if (HAS_MULTI_PERSON.test(instruction)) return null;

  // Pattern 1: ask/tell/get [name] to [task]
  const m1 = instruction.match(
    /^\s*(?:please\s+)?(?:ask|tell|get)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+to\s+(.+)$/i,
  );
  if (m1) {
    const personName = m1[1].trim();
    const taskText = m1[2].trim();
    if (taskText.length >= 3 && matchesPeople(personName, people)) {
      return { personName, taskText };
    }
  }

  // Pattern 2: have [name] [task] — single-word name prevents greedy overlap with task words
  const m2 = instruction.match(
    /^\s*(?:please\s+)?have\s+([a-zA-Z]+)\s+(.+)$/i,
  );
  if (m2) {
    const personName = m2[1].trim();
    // Strip accidental "to" — "have Ghulam to bring the car" → "bring the car"
    const taskText = m2[2].trim().replace(/^to\s+/i, "");
    if (taskText.length >= 3 && matchesPeople(personName, people)) {
      return { personName, taskText };
    }
  }

  return null;
}

export async function executeDelegationFastPath(
  instruction: string,
  context: DelegationFastPathContext,
  deps: DelegationFastPathDeps,
): Promise<DelegationFastPathResult> {
  console.log("[fast_path_delegation_candidate]", { instruction: instruction.slice(0, 100) });

  const parsed = parseDelegationFastPath(instruction, context.people);

  if (!parsed) {
    console.log("[fast_path_delegation_fell_through]", {
      reason: "no_pattern_match",
      instruction: instruction.slice(0, 100),
    });
    return { handled: false, reason: "no_match" };
  }

  const { personName, taskText } = parsed;
  const person = context.people.find(
    (p) => p.name.trim().toLowerCase() === personName.toLowerCase(),
  ) ?? null;

  if (!person) {
    // Pattern matched but person not in store — fall through to Anthropic extraction
    // which may resolve aliases or alternate spellings.
    console.log("[fast_path_delegation_fell_through]", {
      reason: "person_not_found",
      candidateName: personName,
    });
    return { handled: false, reason: "no_match" };
  }

  console.log("[fast_path_delegation_matched]", { name: person.name, task: taskText });

  if (!person.phone?.trim()) {
    console.warn("[fast_path_delegation_blocked]", { reason: "no_phone", name: person.name });
    return {
      handled: true,
      status: "blocked",
      reason: "missing_phone",
      personName: person.name,
      taskText,
      response: `${person.name} doesn't have a phone number saved. Add one in People settings.`,
    };
  }

  if (person.whatsapp_opted_in !== true) {
    console.warn("[fast_path_delegation_blocked]", { reason: "no_consent", name: person.name });
    return {
      handled: true,
      status: "blocked",
      reason: "missing_consent",
      personName: person.name,
      taskText,
      response: `WhatsApp consent isn't recorded for ${person.name}.`,
    };
  }

  try {
    const response = await deps.sendDelegationFn({ name: person.name, task: taskText });
    console.log("[fast_path_delegation_sent]", {
      name: person.name,
      task: taskText,
      result: response.slice(0, 80),
    });
    return {
      handled: true,
      status: "sent",
      personName: person.name,
      taskText,
      response,
    };
  } catch (err) {
    console.error("[fast_path_delegation_failed]", {
      name: person.name,
      task: taskText,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      handled: true,
      status: "failed",
      reason: "send_failed",
      personName: person.name,
      taskText,
      response: `I couldn't send that to ${person.name}. Please try again.`,
    };
  }
}

function matchesPeople(candidateName: string, people: Person[]): boolean {
  const key = candidateName.trim().toLowerCase();
  return people.some((p) => p.name.trim().toLowerCase() === key);
}
