import type { Person } from "../types/person";

// ── Types ─────────────────────────────────────────────────────────────────────

export type CarsonDomain =
  | "task"
  | "delegation"
  | "whatsapp"
  | "reminder"
  | "calendar"
  | "memory"
  | "general_answer"
  | "unknown";

export interface CarsonRoutingResult {
  /** All matching domains, ordered by confidence descending. */
  domains: CarsonDomain[];
  /** The highest-confidence domain. */
  primary_domain: CarsonDomain;
  /** 0–1 confidence in the primary_domain classification. */
  confidence: number;
  /** Human-readable reason for the primary domain classification. */
  reason: string;
  /** True when the instruction is too ambiguous to route reliably. */
  needs_clarification: boolean;
  /** The clarifying question to ask when needs_clarification is true. */
  clarification_question: string | null;
}

export interface CarsonRouterInput {
  transcript: string;
  people?: Pick<Person, "name">[];
  userProfile?: { displayName?: string | null } | null;
  ra7etbalState?: string | null;
}

interface CandidateMatch {
  domain: CarsonDomain;
  confidence: number;
  reason: string;
}

// ── Pronouns that are never person names in delegations ───────────────────────
const SELF_PRONOUNS = new Set(["me", "i", "myself", "us", "we", "you"]);

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Classifies a Carson instruction into one or more domains.
 *
 * Pure pattern-matching — no LLM calls, no network I/O.
 * Results are logged to the console for debugging.
 */
export function classifyCarsonInstruction(
  input: CarsonRouterInput,
): CarsonRoutingResult {
  const { transcript, people = [] } = input;
  const text = transcript.trim();
  const peopleNames = new Set(people.map((p) => p.name.trim().toLowerCase()));

  const candidates: CandidateMatch[] = [
    matchReminder(text),
    matchCalendar(text),
    matchMemory(text),
    matchWhatsApp(text),
    matchDelegation(text, peopleNames),
    matchTask(text),
    matchGeneralAnswer(text),
  ].filter((c): c is CandidateMatch => c !== null);

  candidates.sort((a, b) => b.confidence - a.confidence);

  const primary: CandidateMatch = candidates[0] ?? {
    domain: "unknown",
    confidence: 0.3,
    reason: "No pattern matched the instruction.",
  };

  const domains: CarsonDomain[] = [];
  const seen = new Set<CarsonDomain>();
  for (const c of candidates) {
    if (!seen.has(c.domain)) {
      domains.push(c.domain);
      seen.add(c.domain);
    }
  }
  if (domains.length === 0) domains.push("unknown");

  const needs_clarification = primary.domain === "unknown";
  const clarification_question = needs_clarification
    ? "I'm not sure what you'd like me to do. Could you clarify?"
    : null;

  const result: CarsonRoutingResult = {
    domains,
    primary_domain: primary.domain,
    confidence: Math.round(primary.confidence * 100) / 100,
    reason: primary.reason,
    needs_clarification,
    clarification_question,
  };

  console.log("[carson_router]", {
    transcript: text.slice(0, 120),
    primary_domain: result.primary_domain,
    confidence: result.confidence,
    domains: result.domains,
    reason: result.reason,
    needs_clarification: result.needs_clarification,
  });

  return result;
}

// ── Domain rules ──────────────────────────────────────────────────────────────

function matchReminder(text: string): CandidateMatch | null {
  if (/\bremind\s+me\b/i.test(text)) {
    return {
      domain: "reminder",
      confidence: 0.95,
      reason: "'remind me' is a direct reminder instruction.",
    };
  }
  if (/\bset\s+(a\s+)?reminder\b/i.test(text)) {
    return {
      domain: "reminder",
      confidence: 0.95,
      reason: "'set a reminder' is an explicit reminder request.",
    };
  }
  if (/\bdon'?t\s+let\s+me\s+forget\b/i.test(text)) {
    return {
      domain: "reminder",
      confidence: 0.90,
      reason: "'don't let me forget' maps to a reminder.",
    };
  }
  if (/\balert\s+me\b/i.test(text)) {
    return {
      domain: "reminder",
      confidence: 0.88,
      reason: "'alert me' maps to a reminder.",
    };
  }
  // "remember to [verb]" is a personal reminder, not a memory instruction.
  if (/\bremember\s+to\s+\w+/i.test(text)) {
    return {
      domain: "reminder",
      confidence: 0.80,
      reason: "'remember to [verb]' maps to a personal reminder.",
    };
  }
  return null;
}

function matchCalendar(text: string): CandidateMatch | null {
  if (/\bcalendar\b/i.test(text)) {
    return {
      domain: "calendar",
      confidence: 0.95,
      reason: "Instruction mentions 'calendar' directly.",
    };
  }
  if (
    /\bwhat\s+do\s+I\s+have\s+(today|tomorrow|this\s+week|tonight|this\s+morning|this\s+afternoon)\b/i.test(
      text,
    )
  ) {
    return {
      domain: "calendar",
      confidence: 0.90,
      reason: "'What do I have [time period]' is a calendar query.",
    };
  }
  if (/\b(schedule|book)\s+(a\s+)?(meeting|appointment|call|event)\b/i.test(text)) {
    return {
      domain: "calendar",
      confidence: 0.88,
      reason: "Instruction involves scheduling or booking an event.",
    };
  }
  if (/\b(add|put)\s+.+\s+(to|on)\s+(my\s+)?schedule\b/i.test(text)) {
    return {
      domain: "calendar",
      confidence: 0.85,
      reason: "Instruction involves adding something to a schedule.",
    };
  }
  return null;
}

function matchMemory(text: string): CandidateMatch | null {
  // "remember that [fact]" — saving a durable preference or fact.
  // Distinct from "remember to [verb]" which is a reminder (handled above).
  if (/\bremember\s+that\b/i.test(text)) {
    return {
      domain: "memory",
      confidence: 0.93,
      reason: "'remember that' indicates saving a durable fact or preference.",
    };
  }
  if (/\bfrom\s+now\s+on\b/i.test(text)) {
    return {
      domain: "memory",
      confidence: 0.92,
      reason: "'from now on' signals a persistent behavioral instruction.",
    };
  }
  if (/\b(always|never)\s+(tell|ask|use|send|give|call|write|message|say)\b/i.test(text)) {
    return {
      domain: "memory",
      confidence: 0.85,
      reason: "'always/never [verb]' signals a durable behavioral preference.",
    };
  }
  if (/\bsave\s+(this\s+)?(preference|instruction|rule|behavior|habit)\b/i.test(text)) {
    return {
      domain: "memory",
      confidence: 0.90,
      reason: "Explicit request to save a preference or instruction.",
    };
  }
  if (/\bI\s+prefer\b/i.test(text)) {
    return {
      domain: "memory",
      confidence: 0.82,
      reason: "'I prefer' signals a persistent preference to save.",
    };
  }
  if (/\bprefers?\s+\w+/i.test(text)) {
    return {
      domain: "memory",
      confidence: 0.80,
      reason: "Mentions a person's preference — save as memory.",
    };
  }
  return null;
}

function matchWhatsApp(text: string): CandidateMatch | null {
  if (/\bwhatsapp\s+\w+/i.test(text)) {
    return {
      domain: "whatsapp",
      confidence: 0.95,
      reason: "'WhatsApp [name]' is a direct WhatsApp message request.",
    };
  }
  if (/\bsend\s+\w+\s+(a\s+)?message\b/i.test(text)) {
    return {
      domain: "whatsapp",
      confidence: 0.92,
      reason: "'Send [name] a message' maps to a direct WhatsApp message.",
    };
  }
  if (/\btext\s+\w+\s+(saying|that)\b/i.test(text)) {
    return {
      domain: "whatsapp",
      confidence: 0.90,
      reason: "'Text [name] saying/that' maps to a direct WhatsApp message.",
    };
  }
  if (/\b(dm|direct\s+message)\s+\w+/i.test(text)) {
    return {
      domain: "whatsapp",
      confidence: 0.88,
      reason: "'DM [name]' maps to a direct WhatsApp message.",
    };
  }
  return null;
}

function matchDelegation(
  text: string,
  peopleNames: Set<string>,
): CandidateMatch | null {
  // "ask/tell [name] to [task]"
  const askTellToMatch = text.match(
    /\b(ask|tell)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+to\s+.+/i,
  );
  if (askTellToMatch) {
    const candidateName = (askTellToMatch[2] ?? "").trim();
    if (!SELF_PRONOUNS.has(candidateName.toLowerCase())) {
      const nameIsKnown =
        peopleNames.size > 0 &&
        peopleNames.has(candidateName.toLowerCase());
      return {
        domain: "delegation",
        confidence: nameIsKnown ? 0.97 : 0.88,
        reason: `'${askTellToMatch[1]} ${candidateName} to' matches single-person delegation${nameIsKnown ? " (person is in People list)" : ""}.`,
      };
    }
  }

  // "ask [name] if/whether [condition]" — check-in delegation
  const askIfMatch = text.match(
    /\b(ask|check\s+with|follow\s+up\s+with)\s+([a-zA-Z]+(?:\s+[a-zA-Z]+)?)\s+(if|whether)\b/i,
  );
  if (askIfMatch) {
    const candidateName = (askIfMatch[2] ?? "").trim();
    if (!SELF_PRONOUNS.has(candidateName.toLowerCase())) {
      const nameIsKnown =
        peopleNames.size > 0 &&
        peopleNames.has(candidateName.toLowerCase());
      return {
        domain: "delegation",
        confidence: nameIsKnown ? 0.90 : 0.80,
        reason: `'${askIfMatch[1]} ${candidateName} if/whether' is a check-in delegation${nameIsKnown ? " (person is in People list)" : ""}.`,
      };
    }
  }

  // "have [name] [task]"
  const haveMatch = text.match(/\bhave\s+([a-zA-Z]+)\s+(?!a\s+message)(.+)/i);
  if (haveMatch) {
    const candidateName = (haveMatch[1] ?? "").trim();
    if (!SELF_PRONOUNS.has(candidateName.toLowerCase())) {
      const nameIsKnown =
        peopleNames.size > 0 &&
        peopleNames.has(candidateName.toLowerCase());
      return {
        domain: "delegation",
        confidence: nameIsKnown ? 0.92 : 0.78,
        reason: `'have ${candidateName}' matches delegation pattern${nameIsKnown ? " (person is in People list)" : ""}.`,
      };
    }
  }

  // "get [name] to [task]"
  const getToMatch = text.match(/\bget\s+([a-zA-Z]+)\s+to\s+.+/i);
  if (getToMatch) {
    const candidateName = (getToMatch[1] ?? "").trim();
    if (!SELF_PRONOUNS.has(candidateName.toLowerCase())) {
      const nameIsKnown =
        peopleNames.size > 0 &&
        peopleNames.has(candidateName.toLowerCase());
      return {
        domain: "delegation",
        confidence: nameIsKnown ? 0.92 : 0.78,
        reason: `'get ${candidateName} to' matches delegation pattern${nameIsKnown ? " (person is in People list)" : ""}.`,
      };
    }
  }

  return null;
}

function matchTask(text: string): CandidateMatch | null {
  if (/\b(add|create|make)\s+(a\s+)?(task|todo|to-do)\b/i.test(text)) {
    return {
      domain: "task",
      confidence: 0.88,
      reason: "Explicit task creation request.",
    };
  }
  if (/\badd\s+.+\s+to\s+(my\s+)?(list|tasks)\b/i.test(text)) {
    return {
      domain: "task",
      confidence: 0.82,
      reason: "'Add to my list/tasks' maps to task creation.",
    };
  }
  if (/\b(save|write|note)\s+(this|that|it)\b/i.test(text)) {
    return {
      domain: "task",
      confidence: 0.70,
      reason: "Requesting to save or note an item.",
    };
  }
  return null;
}

function matchGeneralAnswer(text: string): CandidateMatch | null {
  // Exclude calendar queries already matched by matchCalendar.
  if (/\bwhat\s+do\s+I\s+have\b/i.test(text)) return null;
  if (/\bwhat('s|\s+is)\s+on\b/i.test(text) && /\bcalendar\b/i.test(text)) return null;

  if (/\bwhat\s+(is|are|does|do|did|was|were)\b/i.test(text)) {
    return {
      domain: "general_answer",
      confidence: 0.75,
      reason: "'What is/are/does' is a knowledge or status question.",
    };
  }
  if (/\bhow\s+(do|does|can|should|would|is)\b/i.test(text)) {
    return {
      domain: "general_answer",
      confidence: 0.75,
      reason: "'How do/can/is' is a knowledge question.",
    };
  }
  if (/\bexplain\b/i.test(text)) {
    return {
      domain: "general_answer",
      confidence: 0.78,
      reason: "'Explain' requests an explanation.",
    };
  }
  if (/\btell\s+me\s+(about|what)\b/i.test(text)) {
    return {
      domain: "general_answer",
      confidence: 0.72,
      reason: "'Tell me about/what' is a knowledge question.",
    };
  }
  if (/\bwhat('s|\s+is)\s+the\s+/i.test(text)) {
    return {
      domain: "general_answer",
      confidence: 0.70,
      reason: "'What's the X' is a knowledge question.",
    };
  }
  return null;
}
