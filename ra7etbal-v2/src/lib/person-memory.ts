/**
 * person-memory.ts
 *
 * Pure extraction of durable person memories from an owner transcript.
 * Moved unchanged in spirit from ElevenLabsAgentWidget.tsx so it can be
 * tested directly; the widget still owns the write (people store update).
 *
 * Fixes (2026-10-17 memory repair):
 * - One memory per sentence, so a later correction can replace exactly the
 *   sentence it corrects instead of a merged blob.
 * - An explicit standing preference ("prefers", "always", "never",
 *   "from now on", "remember") is durable even when it mentions an
 *   everyday noun like "dinner". Day-bound words still block it.
 * - A first name matches when it is unique in the household, so
 *   "Christopher" reaches the person saved as "Christopher Santos".
 */

import type { Person } from "../types/person";
import type { TranscriptMessage } from "./carson-summarize";

export function normalizeMemoryText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

export function splitIntoSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?])\s+|\n+/)
    .map(normalizeMemoryText)
    .filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DURABLE_SIGNALS = [
  "often",
  "usually",
  "always",
  "tends to",
  "needs",
  "prefers",
  "reliable",
  "responsible",
  "punctual",
  "helpful",
  "proactive",
  "strong",
  "protective",
  "bodyguard",
  "bossy",
  "controlling",
  "clear instructions",
  "follow-up",
  "follow up",
];

// A standing preference stated explicitly by the owner.
const EXPLICIT_PREFERENCE = /\b(prefers?|always|never|from now on|going forward|remember)\b/;

// Words that make a sentence about a single day — never durable.
const DAY_BOUND_SIGNALS = ["today", "tonight", "tomorrow", " at 7", " at 9"];

// Everyday nouns that usually signal a one-off errand. They block only when
// the sentence is not an explicit standing preference.
const ERRAND_SIGNALS = ["guests", "dinner", "flowers", "cars", "kitchen", "gets home", "arrive", "arrives"];

export function isLikelyDurablePersonContext(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  if (!DURABLE_SIGNALS.some((signal) => lower.includes(signal))) return false;
  if (DAY_BOUND_SIGNALS.some((signal) => lower.includes(signal))) return false;
  if (EXPLICIT_PREFERENCE.test(lower)) return true;
  return !ERRAND_SIGNALS.some((signal) => lower.includes(signal));
}

function namePatternsFor(person: Person, people: Person[]): RegExp[] {
  const name = person.name.trim();
  const patterns = [new RegExp(`\\b${escapeRegex(name)}\\b`, "i")];
  const first = name.split(/\s+/)[0];
  if (first && first.length > 1 && first.toLowerCase() !== name.toLowerCase()) {
    const sharesFirstName = people.some(
      (other) =>
        other.id !== person.id &&
        other.name.trim().split(/\s+/)[0]?.toLowerCase() === first.toLowerCase(),
    );
    if (!sharesFirstName) patterns.push(new RegExp(`\\b${escapeRegex(first)}\\b`, "i"));
  }
  return patterns;
}

/**
 * Durable memories per person, one entry per sentence, in spoken order.
 * Only the owner's (user-role) words are used.
 */
export function extractDurablePersonMemories(
  transcript: TranscriptMessage[],
  people: Person[],
): Array<{ person: Person; memory: string }> {
  const userText = transcript
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.message)
    .join("\n");
  if (!userText.trim() || people.length === 0) return [];

  const sentences = splitIntoSentences(userText);
  const updates: Array<{ person: Person; memory: string }> = [];

  for (const person of people) {
    if (!person.name?.trim()) continue;
    const patterns = namePatternsFor(person, people);
    for (const sentence of sentences) {
      const match = patterns.find((p) => p.test(sentence));
      if (!match || !isLikelyDurablePersonContext(sentence)) continue;
      const memory = normalizeMemoryText(
        sentence.replace(match, "").replace(/^[:,\-\s]+/, ""),
      );
      if (memory) updates.push({ person, memory });
    }
  }

  return updates;
}

/**
 * Fold extracted memories into ONE notes value per person, in spoken order,
 * so a later sentence (a correction) replaces an earlier one and no write
 * overwrites another with stale notes. Returns only people whose notes
 * actually change. `merge` is mergePersonNotes (injected to keep this pure).
 */
export function foldPersonMemoryUpdates(
  updates: Array<{ person: Person; memory: string }>,
  merge: (existing: string | null | undefined, addition: string) => string,
): Array<{ person: Person; notes: string }> {
  const byPerson = new Map<string, { person: Person; original: string; notes: string }>();
  for (const { person, memory } of updates) {
    const current = byPerson.get(person.id) ?? {
      person,
      original: person.notes ?? "",
      notes: person.notes ?? "",
    };
    current.notes = merge(current.notes, memory);
    byPerson.set(person.id, current);
  }
  return [...byPerson.values()]
    .filter((entry) => entry.notes !== entry.original)
    .map(({ person, notes }) => ({ person, notes }));
}
