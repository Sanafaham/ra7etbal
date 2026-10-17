/**
 * Regression tests for shared/carson-memory-selection.js — the single memory
 * decision point for Talk, Type and WhatsApp Carson.
 *
 * Fixtures are synthetic. The fact fixture mirrors the verified production
 * SHAPE (2026-10-17 read-only count query: 378 active facts for the main
 * owner across these categories) but none of its content.
 */

import { describe, it, expect } from "vitest";
import {
  buildCarsonMemoryContext,
  buildPeopleIndex,
  findFactsSupersededBy,
  formatSessionRecaps,
  memorySubject,
  mergePersonMemoryNotes,
  renderPersonNotesForContext,
  selectRelevantFacts,
  type FactRow,
  type InstructionRow,
} from "../../shared/carson-memory-selection.js";

const OWNER = "owner-a";
const OTHER_OWNER = "owner-b";
const NOW = Date.parse("2026-10-17T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const PEOPLE = [
  { id: "p-christopher", name: "Christopher Santos" },
  { id: "p-grace", name: "Grace" },
  { id: "p-loulya", name: "Loulya" },
];

// Category sizes from the verified production shape (content is invented).
const CATEGORY_SIZES: Record<string, number> = {
  canary: 1,
  carson: 2,
  communication_style: 80,
  correction: 4,
  identity: 15,
  language: 30,
  notification_preference: 5,
  preference: 36,
  preferences: 3,
  product: 3,
  product_direction: 26,
  profile: 1,
  pronunciation: 18,
  recurring_responsibility: 39,
  relationship: 117,
  routine: 6,
};

function factFixture(): FactRow[] {
  const rows: FactRow[] = [];
  let n = 0;
  for (const [category, size] of Object.entries(CATEGORY_SIZES)) {
    for (let i = 0; i < size; i += 1) {
      n += 1;
      rows.push({
        id: `f-${n}`,
        user_id: OWNER,
        category,
        key: `${category}_topic_${String(i).padStart(3, "0")}`,
        value: `Synthetic ${category} memory number ${i} about topic${n}.`,
        confidence: 0.9,
        updated_at: daysAgo(30 + (n % 40)),
      });
    }
  }
  return rows;
}

const christopherFact: FactRow = {
  id: "f-christopher-dinner",
  user_id: OWNER,
  category: "relationship",
  key: "christopher_dinner_instruction_time",
  value: "Christopher prefers dinner instructions before 3 PM.",
  confidence: 0.95,
  updated_at: daysAgo(2),
};

/** The pre-repair query: first 50 rows ordered by category, then key. */
function legacyAlphabeticalFirst50(rows: FactRow[]): FactRow[] {
  return [...rows]
    .sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key))
    .slice(0, 50);
}

function instruction(id: string, text: string, createdDaysAgo: number, extra: Partial<InstructionRow> = {}): InstructionRow {
  return {
    id,
    user_id: OWNER,
    category: "general",
    instruction: text,
    source: "owner_directive",
    created_at: daysAgo(createdDaysAgo),
    confirmed_at: daysAgo(createdDaysAgo),
    ...extra,
  };
}

// ── 1 & 2. Retrieval beyond the first 50 / relationship + preference ────────

describe("fact retrieval — relevance, not alphabetical order", () => {
  it("counterfactual: the legacy first-50-alphabetical query never reaches Christopher's fact", () => {
    const rows = [...factFixture(), christopherFact];
    expect(rows.length).toBe(387);
    const legacy = legacyAlphabeticalFirst50(rows);
    expect(legacy.map((r) => r.id)).not.toContain(christopherFact.id);
    expect(new Set(legacy.map((r) => r.category))).toEqual(new Set(["canary", "carson", "communication_style"]));
  });

  it("retrieves the Christopher fact when Christopher is in the conversation, though it sorts far past row 50", () => {
    const rows = [...factFixture(), christopherFact];
    const result = buildCarsonMemoryContext({
      ownerId: OWNER,
      facts: rows,
      people: PEOPLE,
      contextText: "Can you send Christopher tonight's dinner plan?",
      now: NOW,
    });
    expect(result.userMemory).toContain("Christopher prefers dinner instructions before 3 PM.");
  });

  it("gives every category a share so relationship and preference facts are never systematically excluded", () => {
    const selected = buildCarsonMemoryContext({ ownerId: OWNER, facts: factFixture(), people: PEOPLE, now: NOW }).selectedFacts;
    const categories = new Set(selected.map((f) => f.category));
    for (const category of Object.keys(CATEGORY_SIZES)) {
      expect(categories, `category ${category} missing`).toContain(category);
    }
    expect(selected.filter((f) => f.category === "relationship").length).toBeGreaterThanOrEqual(2);
    expect(selected.filter((f) => f.category === "preference").length).toBeGreaterThanOrEqual(2);
  });

  it("does not flood the context: bounded by count and character budget", () => {
    const selected = selectRelevantFacts(factFixture(), { limit: 60, charBudget: 7000, now: NOW });
    expect(selected.length).toBeLessThanOrEqual(60);
    const chars = selected.map((f) => `- ${f.category} / ${f.key}: ${f.value}`.length + 1).reduce((a, b) => a + b, 0);
    expect(chars).toBeLessThanOrEqual(7000);
  });

  it("prefers facts about people in the conversation over unrelated recent facts", () => {
    const grace: FactRow = { id: "f-grace", user_id: OWNER, category: "relationship", key: "grace_style", value: "Grace prefers voice notes.", updated_at: daysAgo(200) };
    const selected = selectRelevantFacts([...factFixture(), grace], {
      contextText: "Remind Grace about the laundry",
      peopleIndex: buildPeopleIndex(PEOPLE),
      limit: 10,
      now: NOW,
    });
    expect(selected[0].id).toBe("f-grace");
  });
});

// ── 3. Christopher's 4 PM → 3 PM correction ──────────────────────────────────

describe("Christopher 4 PM → 3 PM correction", () => {
  const first = "Christopher prefers receiving dinner instructions before 4 PM.";
  const correction = "Actually, Christopher now prefers receiving dinner instructions before 3 PM.";

  it("recognises the correction as the same subject with a new value", () => {
    const idx = buildPeopleIndex(PEOPLE);
    const a = memorySubject(first, idx);
    const b = memorySubject(correction, idx);
    expect(a.key).not.toBeNull();
    expect(a.key).toBe(b.key);
    expect(a.values).toContain("4pm");
    expect(b.values).toContain("3pm");
  });

  it("standing instructions: only 3 PM is current guidance; 4 PM is never handed to Carson", () => {
    const result = buildCarsonMemoryContext({
      ownerId: OWNER,
      instructions: [instruction("i-4pm", first, 10), instruction("i-3pm", correction, 1)],
      people: PEOPLE,
      now: NOW,
    });
    expect(result.persistentInstructions).toContain("before 3 PM");
    expect(result.persistentInstructions).not.toContain("before 4 PM");
    expect(result.supersededInstructionIds).toEqual(["i-4pm"]);
    expect(result.currentInstructions.map((r) => r.id)).toEqual(["i-3pm"]);
  });

  it("the correction is attributed to the owner (owner_directive provenance retained)", () => {
    const result = buildCarsonMemoryContext({
      ownerId: OWNER,
      instructions: [instruction("i-4pm", first, 10), instruction("i-3pm", correction, 1)],
      people: PEOPLE,
      now: NOW,
    });
    expect(result.currentInstructions[0].source).toBe("owner_directive");
    expect(result.currentInstructions[0].user_id).toBe(OWNER);
  });

  it("cross-store: a later fact correction replaces an older standing instruction and is always shown", () => {
    const fact3pm: FactRow = { ...christopherFact, updated_at: daysAgo(1) };
    const result = buildCarsonMemoryContext({
      ownerId: OWNER,
      instructions: [instruction("i-4pm", first, 10)],
      facts: [...factFixture(), fact3pm],
      people: PEOPLE,
      contextText: "nothing about him here",
      now: NOW,
    });
    expect(result.persistentInstructions).not.toContain("4 PM");
    // Pinned even though Christopher is not in the context and 386 other facts compete.
    expect(result.userMemory).toContain("before 3 PM");
  });

  it("a later instruction wins over an older fact on the same subject", () => {
    const old4pmFact: FactRow = { ...christopherFact, value: "Christopher prefers dinner instructions before 4 PM.", updated_at: daysAgo(20) };
    const result = buildCarsonMemoryContext({
      ownerId: OWNER,
      instructions: [instruction("i-3pm", correction, 1)],
      facts: [old4pmFact],
      people: PEOPLE,
      contextText: "Christopher dinner",
      now: NOW,
    });
    expect(result.persistentInstructions).toContain("3 PM");
    expect(result.userMemory).not.toContain("4 PM");
    expect(result.supersededFactIds).toEqual([old4pmFact.id]);
  });

  it("findFactsSupersededBy archives the 4 PM fact only when the new fact uses a different key", () => {
    const old: FactRow = { id: "f-old", user_id: OWNER, category: "relationship", key: "christopher_dinner_time", value: "Christopher prefers dinner instructions before 4 PM." };
    const sameKey = [{ category: "relationship", key: "christopher_dinner_time", value: "Christopher prefers dinner instructions before 3 PM." }];
    const newKey = [{ category: "preference", key: "christopher_dinner_deadline", value: "Christopher prefers dinner instructions before 3 PM." }];
    expect(findFactsSupersededBy([old], sameKey, PEOPLE)).toEqual([]); // upsert overwrites in place
    expect(findFactsSupersededBy([old], newKey, PEOPLE)).toEqual(["f-old"]);
  });
});

// ── 4. Conflicting old and new instructions ─────────────────────────────────

describe("conflicting instructions", () => {
  it("newer owner instruction replaces an older one (polarity and number values)", () => {
    const result = buildCarsonMemoryContext({
      instructions: [
        instruction("a", "Always ask before delegating", 30),
        instruction("b", "Keep responses under two sentences", 20),
        instruction("c", "Never ask before delegating", 5),
        instruction("d", "Actually, keep responses under three sentences", 2),
      ],
      now: NOW,
    });
    expect(result.currentInstructions.map((r) => r.id).sort()).toEqual(["c", "d"]);
  });

  // Independent review (2026-10-17): these distinct true memories differ only
  // in a value and must NEVER replace each other (false supersession).
  it.each([
    ["Wake me up at 6 AM on weekdays", "Wake me up at 8 AM on weekends"],
    ["Remind me to take my meds at 8am", "Remind me to take my meds at 8pm"],
    ["Don't send work emails before 8am", "Don't send work emails after 8pm"],
    ["Grace cleans the house on Mondays", "Grace cleans the house on Thursdays"],
    ["Christopher works Monday to Friday", "Christopher works Saturdays"],
    ["Joseph speaks Arabic", "Joseph speaks English"],
    ["Gym at 6am", "Gym at 7pm"],
    ["Never schedule meetings on Fridays", "Always schedule meetings on Mondays"],
    ["Maria Santos cooks lunch", "Maria Cruz cooks lunch"],
    ["Keep responses under two sentences", "Keep responses under three sentences"],
    ["Grace works Mondays", "Grace works Saturdays too"],
  ])("keeps both: %s / %s", (older, newer) => {
    const people = [...PEOPLE, { id: "p-j", name: "Joseph" }, { id: "p-ms", name: "Maria Santos" }, { id: "p-mc", name: "Maria Cruz" }];
    const result = buildCarsonMemoryContext({
      instructions: [instruction("old", older, 5), instruction("new", newer, 1)],
      people,
      now: NOW,
    });
    expect(result.currentInstructions.map((r) => r.id).sort()).toEqual(["new", "old"]);
    expect(findFactsSupersededBy(
      [{ id: "f-old", category: "routine", key: "a", value: older }],
      [{ category: "routine", key: "b", value: newer }],
      people,
    )).toEqual([]);
  });

  it("a name that is also a word only counts as the person when written as a name", () => {
    const idx = buildPeopleIndex([{ id: "p-w", name: "Will" }]);
    expect(memorySubject("Ask Will to call the plumber", idx).people).toEqual(["p-w"]);
    expect(memorySubject("I will call the plumber", idx).people).toEqual([]);
  });

  it("different subjects coexist: lunch vs dinner, time vs language, Grace vs Christopher", () => {
    const rows = [
      instruction("1", "Christopher prefers lunch instructions before noon", 9),
      instruction("2", "Christopher prefers dinner instructions before 4 PM", 8),
      instruction("3", "Christopher prefers dinner instructions in Arabic", 7),
      instruction("4", "Grace prefers dinner instructions before 4 PM", 6),
    ];
    const result = buildCarsonMemoryContext({ instructions: rows, people: PEOPLE, now: NOW });
    expect(result.currentInstructions).toHaveLength(4);
  });

  it("an inferred instruction never overrides an owner directive, even when newer", () => {
    const result = buildCarsonMemoryContext({
      instructions: [
        instruction("owner", "Christopher prefers dinner instructions before 4 PM", 10),
        instruction("inferred", "Christopher prefers dinner instructions before 6 PM", 1, { source: "session_inference" }),
      ],
      people: PEOPLE,
      now: NOW,
    });
    expect(result.currentInstructions.map((r) => r.id)).toEqual(["owner"]);
  });
});

// ── 8. Tenant isolation ──────────────────────────────────────────────────────

describe("tenant isolation", () => {
  it("drops another owner's instructions and facts even if they reach the builder", () => {
    const result = buildCarsonMemoryContext({
      ownerId: OWNER,
      instructions: [
        instruction("mine", "Keep answers short", 3),
        { ...instruction("theirs", "Christopher prefers dinner instructions before 9 PM", 1), user_id: OTHER_OWNER },
      ],
      facts: [{ ...christopherFact, id: "their-fact", user_id: OTHER_OWNER, value: "Christopher prefers dinner at 9 PM." }],
      people: PEOPLE,
      contextText: "Christopher",
      now: NOW,
    });
    expect(result.persistentInstructions).toContain("Keep answers short");
    expect(result.persistentInstructions).not.toContain("9 PM");
    expect(result.userMemory).toBe("");
  });

  it("another owner's newer row can never supersede this owner's memory", () => {
    const result = buildCarsonMemoryContext({
      ownerId: OWNER,
      instructions: [
        instruction("mine", "Christopher prefers dinner instructions before 4 PM", 10),
        { ...instruction("theirs", "Christopher prefers dinner instructions before 1 PM", 1), user_id: OTHER_OWNER },
      ],
      people: PEOPLE,
      now: NOW,
    });
    expect(result.currentInstructions.map((r) => r.id)).toEqual(["mine"]);
  });
});

// ── 9. Missing, stale, ambiguous, contradictory ─────────────────────────────

describe("missing, stale, ambiguous and contradictory memory", () => {
  it("missing memory yields empty blocks, never undefined text", () => {
    const result = buildCarsonMemoryContext({});
    expect(result.persistentInstructions).toBe("");
    expect(result.userMemory).toBe("");
  });

  it("stale instructions are kept but labelled for re-confirmation", () => {
    const result = buildCarsonMemoryContext({ instructions: [instruction("s", "Keep answers short", 120)], now: NOW, staleDays: 90 });
    expect(result.persistentInstructions).toContain("re-confirmation");
  });

  it("ambiguous pronoun-only correction is not guessed: both stay, newest last, with the newer-wins rule stated", () => {
    const result = buildCarsonMemoryContext({
      instructions: [
        instruction("a", "Christopher prefers dinner instructions before 4 PM", 5),
        instruction("b", "He now wants them by 3", 1),
      ],
      people: PEOPLE,
      now: NOW,
    });
    const text = result.persistentInstructions;
    expect(result.currentInstructions).toHaveLength(2);
    expect(text).toContain("If two ever conflict, follow the newer one");
    expect(text.indexOf("4 PM")).toBeLessThan(text.indexOf("by 3"));
  });

  it("a subject-less memory is never silently hidden", () => {
    const result = buildCarsonMemoryContext({ instructions: [instruction("x", "Always", 1)], now: NOW });
    expect(result.currentInstructions).toHaveLength(1);
  });

  it("exact restatement of the same instruction collapses to one current copy", () => {
    const result = buildCarsonMemoryContext({
      instructions: [instruction("a", "Keep answers short", 10), instruction("b", "Keep answers short.", 1)],
      now: NOW,
    });
    expect(result.currentInstructions.map((r) => r.id)).toEqual(["b"]);
  });

  it("archived facts are never used", () => {
    const result = buildCarsonMemoryContext({
      facts: [{ ...christopherFact, archived_at: daysAgo(1) }],
      people: PEOPLE,
      contextText: "Christopher",
      now: NOW,
    });
    expect(result.userMemory).toBe("");
  });
});

// ── 5. Person notes ──────────────────────────────────────────────────────────

describe("person notes", () => {
  const longOwnerNotes = [
    "Has worked with the family since 2019 and knows every household routine in detail.",
    ...Array.from({ length: 30 }, (_, i) => `Owner note ${i}: handles the weekly market run and keeps receipts in the blue folder.`),
    "prefers receiving dinner instructions before 4 PM.",
    "[Behavior: Christopher usually confirms within an hour.]",
  ].join("\n");

  it("fixture is a full, owner-written note longer than the old 1,000-character cap", () => {
    expect(longOwnerNotes.length).toBeGreaterThan(2500);
  });

  it("a full note still receives the correction; the 4 PM line is replaced; nothing else is cut", () => {
    const { notes, replaced } = mergePersonMemoryNotes(longOwnerNotes, "now prefers receiving dinner instructions before 3 PM.");
    expect(notes).toContain("before 3 PM");
    expect(notes).not.toContain("before 4 PM");
    expect(replaced).toEqual(["prefers receiving dinner instructions before 4 PM."]);
    expect(notes).toContain("Has worked with the family since 2019");
    expect(notes).toContain("Owner note 29");
    expect(notes).toContain("[Behavior: Christopher usually confirms within an hour.]");
    expect(notes.split("\n").length).toBe(longOwnerNotes.split("\n").length); // line breaks preserved
  });

  it("counterfactual: the legacy merge kept the oldest 1,000 characters and dropped the correction", () => {
    const legacy = (existing: string, addition: string) =>
      `${existing.trim().replace(/\s+/g, " ")}\n${addition.trim()}`.slice(0, 1_000);
    const out = legacy(longOwnerNotes, "now prefers receiving dinner instructions before 3 PM.");
    expect(out).not.toContain("3 PM");
    expect(out.length).toBe(1000);
  });

  it("additive learning never deletes an owner-written sentence", () => {
    const { notes, replaced } = mergePersonMemoryNotes(
      "Usually works Mondays and Thursdays. Long-time housekeeper.",
      "usually works Saturdays too.",
    );
    expect(replaced).toEqual([]);
    expect(notes).toContain("Usually works Mondays and Thursdays.");
  });

  it("a substring is not a duplicate: 'Likes tea.' is recorded next to 'Dislikes tea.'", () => {
    const res = mergePersonMemoryNotes("Dislikes tea.", "Likes tea.");
    expect(res.changed).toBe(true);
    expect(res.notes).toContain("Likes tea.");
  });

  it("duplicates leave notes unchanged", () => {
    const res = mergePersonMemoryNotes("Warm and reliable.", "warm and reliable");
    expect(res.changed).toBe(false);
  });

  it("only the corrected sentence is removed from a multi-sentence line", () => {
    const { notes } = mergePersonMemoryNotes(
      "Very reliable. Prefers dinner instructions before 4 PM.",
      "Prefers dinner instructions before 3 PM.",
    );
    expect(notes).toBe("Very reliable.\nPrefers dinner instructions before 3 PM.");
  });

  it("rendering for Carson keeps the newest lines when space is short", () => {
    const { notes } = mergePersonMemoryNotes(longOwnerNotes, "now prefers receiving dinner instructions before 3 PM.");
    const rendered = renderPersonNotesForContext(notes, 200);
    expect(rendered.length).toBeLessThanOrEqual(200);
    expect(rendered).toContain("3 PM");
  });
});

// ── 6 (shared part). Session recap formatting ───────────────────────────────

describe("formatSessionRecaps", () => {
  const recap = { created_at: "2026-10-16T09:00:00.000Z", summary: "• Session recap: asked Grace about laundry" };

  it("uses only recap rows", () => {
    const out = formatSessionRecaps([{ created_at: recap.created_at, summary: "durable note, not a recap" }]);
    expect(out).toContain("No previous sessions.");
  });

  it("an invalid saved timezone falls back to UTC instead of throwing", () => {
    expect(() => formatSessionRecaps([recap], { timeZone: "Not/AZone", locale: "en-US" })).not.toThrow();
    expect(formatSessionRecaps([recap], { timeZone: "Not/AZone", locale: "en-US" })).toContain("Most recent session");
  });
});
