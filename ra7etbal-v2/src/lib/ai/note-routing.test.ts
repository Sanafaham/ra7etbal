import { describe, expect, it } from "vitest";
import { applyNoteRouting } from "./note-routing";
import type { ExtractedItem } from "../../types/extraction";

function item(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    id: "i1",
    type: "action",
    description: "Follow the Gemini plan",
    assignedTo: null,
    dueAt: null,
    dueText: null,
    suggestedMessage: null,
    personalNote: null,
    needsPerson: false,
    needsClarification: false,
    clarificationQuestion: null,
    ...overrides,
  };
}

describe("applyNoteRouting — Clear My Head / Talk to Carson Notes misrouting fix", () => {
  it("'Note to follow Gemini plan' (model said action) → parked", () => {
    const [result] = applyNoteRouting(
      [item({ type: "action", description: "Follow the Gemini plan" })],
      "Note to follow Gemini plan",
    );
    expect(result.type).toBe("parked");
  });

  it("'Save this note: follow Gemini plan' (model said action) → parked", () => {
    const [result] = applyNoteRouting(
      [item({ type: "action", description: "Follow Gemini plan" })],
      "Save this note: follow Gemini plan",
    );
    expect(result.type).toBe("parked");
  });

  it("'Remember this idea for later' (model said errand) → parked", () => {
    const [result] = applyNoteRouting(
      [item({ type: "errand", description: "Some idea" })],
      "Remember this idea for later",
    );
    expect(result.type).toBe("parked");
  });

  it("'Hold this thought about the menu' (model said action) → parked", () => {
    const [result] = applyNoteRouting(
      [item({ type: "action", description: "Menu thought" })],
      "Hold this thought about the menu",
    );
    expect(result.type).toBe("parked");
  });

  it("already-parked items are left alone (no-op, no new object identity needed)", () => {
    const original = item({ type: "parked", description: "Follow the Gemini plan" });
    const [result] = applyNoteRouting([original], "Note to follow Gemini plan");
    expect(result.type).toBe("parked");
  });

  it("no note trigger in the text → items pass through unchanged", () => {
    const original = item({ type: "action", description: "Buy flowers" });
    const [result] = applyNoteRouting([original], "Buy flowers");
    expect(result).toEqual(original);
  });

  it("'Buy flowers' (no note language) stays action, not forced to parked", () => {
    const [result] = applyNoteRouting(
      [item({ type: "action", description: "Buy flowers" })],
      "Buy flowers",
    );
    expect(result.type).toBe("action");
  });

  it("'Add buy flowers to my to-do list' (no note language) stays action, untouched", () => {
    const [result] = applyNoteRouting(
      [item({ type: "action", description: "Buy flowers" })],
      "Add buy flowers to my to-do list",
    );
    expect(result.type).toBe("action");
  });

  it("multi-item input: only the item from the note-triggering clause is reclassified", () => {
    const results = applyNoteRouting(
      [
        item({ id: "a", type: "action", description: "Buy flowers" }),
        item({ id: "b", type: "action", description: "Follow the Gemini plan" }),
      ],
      "Buy flowers. Note to follow the Gemini plan.",
    );
    expect(results.find((r) => r.id === "a")?.type).toBe("action");
    expect(results.find((r) => r.id === "b")?.type).toBe("parked");
  });

  it("preserves all other item fields unchanged when reclassifying", () => {
    const original = item({
      type: "action",
      description: "Follow the Gemini plan",
      personalNote: "for later",
    });
    const [result] = applyNoteRouting([original], "Note to follow the Gemini plan");
    expect(result).toEqual({ ...original, type: "parked" });
  });
});
