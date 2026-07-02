import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedItem } from "../types/extraction";

// extraction.ts transitively imports ../lib/ai/extract-photo -> ../lib/image-upload
// -> ../lib/supabase, which throws at module load without VITE_SUPABASE_* env
// vars. Stub it — these tests only exercise the pure removeItem reducer, never
// anything that talks to Supabase. Same pattern as save.test.ts.
vi.mock("../lib/supabase", () => ({ supabase: {} }));

const { useExtractionStore } = await import("./extraction");

/**
 * Regression suite for the Clear My Head Review "Remove" control
 * (requirement 1-3: a removed item must be gone from the review list, and
 * since Review.tsx / savePending() only ever operate on this store's
 * `items` array, removal here is what guarantees a removed item is never
 * saved, sent, delegated, reminded, or converted into a note/task).
 */

function item(overrides: Partial<ExtractedItem> = {}): ExtractedItem {
  return {
    id: "i1",
    type: "action",
    description: "Buy flowers",
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

beforeEach(() => {
  useExtractionStore.setState({
    status: "idle",
    items: [],
    summary: "",
    sourceText: "",
    error: null,
  });
});

describe("useExtractionStore.removeItem", () => {
  it("removes one item from a multi-item review, leaving the rest untouched", () => {
    useExtractionStore.setState({
      status: "ready",
      items: [
        item({ id: "a", type: "parked", description: "Save this idea" }),
        item({ id: "b", type: "todo", description: "Renew passport" }),
        item({ id: "c", type: "reminder", description: "Call the vet", assignedTo: "__me__" }),
      ],
    });

    useExtractionStore.getState().removeItem("b");

    const ids = useExtractionStore.getState().items.map((it) => it.id);
    expect(ids).toEqual(["a", "c"]);
  });

  it("removing every item leaves an empty list (drives the empty-state / disabled Save & Send)", () => {
    useExtractionStore.setState({
      status: "ready",
      items: [item({ id: "a" }), item({ id: "b" })],
    });

    useExtractionStore.getState().removeItem("a");
    useExtractionStore.getState().removeItem("b");

    expect(useExtractionStore.getState().items).toEqual([]);
  });

  it("removing a non-existent id is a no-op", () => {
    const seed = [item({ id: "a" }), item({ id: "b" })];
    useExtractionStore.setState({ status: "ready", items: seed });

    useExtractionStore.getState().removeItem("does-not-exist");

    expect(useExtractionStore.getState().items.map((it) => it.id)).toEqual(["a", "b"]);
  });

  it("does not mutate other item fields — only filters the array", () => {
    useExtractionStore.setState({
      status: "ready",
      items: [
        item({ id: "a", description: "Keep me", suggestedMessage: "Hi there" }),
        item({ id: "b" }),
      ],
    });

    useExtractionStore.getState().removeItem("b");

    const [remaining] = useExtractionStore.getState().items;
    expect(remaining.description).toBe("Keep me");
    expect(remaining.suggestedMessage).toBe("Hi there");
  });
});
