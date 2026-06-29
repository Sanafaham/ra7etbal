import type { ExtractedItem } from "../../types/extraction";

/**
 * Deterministic safety net for explicit note-saving language.
 *
 * The extraction prompt has worked examples for delegation/message/reminder
 * phrasing, but explicit note phrases ("Note to follow the Gemini plan",
 * "Save this note: …", "Remember this idea for later", "Hold this thought
 * about the menu") are action-shaped on the surface — the model sometimes
 * classifies them as "action"/"errand", which applyTodoRouting() then
 * promotes to "todo". Explicit note-saving language should always win over
 * that: the user said "note"/"save this idea"/"remember this idea"/"hold
 * this thought" — they want passive information captured, not a commitment
 * tracked in To-do.
 *
 * Must run BEFORE applyTodoRouting() so a reclassified "parked" item is
 * never picked up by the action/errand → todo promotion.
 */
const NOTE_TRIGGER_PATTERNS: RegExp[] = [
  /\bnote\s+to\s+\w+/i,
  /\bsave\s+(this|that)\s+(note|idea|thought)\b/i,
  /\bremember\s+this\s+(idea|thought|information)\b/i,
  /\bhold\s+this\s+thought\b/i,
  /\badd\s+this\s+to\s+(my\s+)?notes\b/i,
];

export function hasExplicitNoteIntent(text: string): boolean {
  return NOTE_TRIGGER_PATTERNS.some((re) => re.test(text));
}

function stripNoteTrigger(clause: string): string {
  for (const re of NOTE_TRIGGER_PATTERNS) {
    const stripped = clause.replace(re, "").trim();
    if (stripped !== clause) return stripped.replace(/^[:,\-]+/, "").trim();
  }
  return clause;
}

function sharesWord(a: string, b: string): boolean {
  const wordsA = new Set(
    a.toLowerCase().split(/\W+/).filter((w) => w.length > 2),
  );
  return b
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2)
    .some((w) => wordsA.has(w));
}

export function applyNoteRouting(
  items: ExtractedItem[],
  sourceText: string,
): ExtractedItem[] {
  if (items.length === 0 || !sourceText || !hasExplicitNoteIntent(sourceText)) {
    return items;
  }

  // Single-item input — the whole text is the note. Explicit note-saving
  // language always wins over whatever shape the model assigned.
  if (items.length === 1) {
    const [item] = items;
    if (item.type === "parked") return items;
    return [{ ...item, type: "parked" }];
  }

  // Multi-item input — only reclassify the item(s) that plausibly came
  // from the note-triggering clause. Never guess across the whole batch.
  const clauses = sourceText
    .split(/[.;\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  const noteClauses = clauses.filter(hasExplicitNoteIntent);
  if (noteClauses.length === 0) return items;

  return items.map((item) => {
    if (item.type === "parked") return item;
    const matchesNoteClause = noteClauses.some((clause) => {
      const content = stripNoteTrigger(clause);
      return content.length > 0 && sharesWord(content, item.description);
    });
    return matchesNoteClause ? { ...item, type: "parked" } : item;
  });
}
