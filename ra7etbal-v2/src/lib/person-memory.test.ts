import { describe, it, expect, vi } from "vitest";

vi.mock("./supabase", () => ({ supabase: {} }));
import type { Person } from "../types/person";
import type { TranscriptMessage } from "./carson-summarize";
import {
  extractDurablePersonMemories,
  foldPersonMemoryUpdates,
  isLikelyDurablePersonContext,
} from "./person-memory";
import { mergePersonNotes } from "./people-behavior";

function person(id: string, name: string, notes: string | null = null): Person {
  return { id, name, notes } as unknown as Person;
}

const user = (message: string): TranscriptMessage => ({ role: "user", message } as TranscriptMessage);
const agent = (message: string): TranscriptMessage => ({ role: "agent", message } as TranscriptMessage);

describe("isLikelyDurablePersonContext", () => {
  it("an explicit standing preference mentioning dinner is durable (was rejected by the old filter)", () => {
    expect(isLikelyDurablePersonContext("Christopher prefers receiving dinner instructions before 4 PM.")).toBe(true);
  });

  it("a one-off dinner errand is still not durable", () => {
    expect(isLikelyDurablePersonContext("Christopher needs to set the table for dinner guests")).toBe(false);
  });

  it("anything bound to today/tonight/tomorrow is never durable, even with a preference word", () => {
    expect(isLikelyDurablePersonContext("Christopher prefers to cook tonight")).toBe(false);
  });
});

describe("extractDurablePersonMemories", () => {
  const christopher = person("p-c", "Christopher Santos");
  const grace = person("p-g", "Grace");

  it("matches a unique first name and keeps the owner's words only", () => {
    const updates = extractDurablePersonMemories(
      [user("Christopher prefers receiving dinner instructions before 4 PM. Remember that."), agent("Christopher prefers 9 PM.")],
      [christopher, grace],
    );
    expect(updates).toEqual([{ person: christopher, memory: "prefers receiving dinner instructions before 4 PM." }]);
  });

  it("does not match an ambiguous first name shared by two people", () => {
    const other = person("p-c2", "Christopher Lee");
    const updates = extractDurablePersonMemories(
      [user("Christopher prefers dinner instructions before 4 PM.")],
      [christopher, other],
    );
    expect(updates).toEqual([]);
  });

  it("returns one memory per sentence, in spoken order", () => {
    const updates = extractDurablePersonMemories(
      [user("Grace is very reliable. Grace prefers voice notes.")],
      [grace],
    );
    expect(updates.map((u) => u.memory)).toEqual(["is very reliable.", "prefers voice notes."]);
  });
});

describe("foldPersonMemoryUpdates — the 4 PM → 3 PM correction within one session", () => {
  it("one write per person; the later correction replaces the earlier statement", () => {
    const christopher = person("p-c", "Christopher Santos", "Warm and dependable.");
    const updates = extractDurablePersonMemories(
      [
        user("Christopher prefers receiving dinner instructions before 4 PM."),
        user("Actually, Christopher now prefers receiving dinner instructions before 3 PM."),
      ],
      [christopher],
    );
    const writes = foldPersonMemoryUpdates(updates, mergePersonNotes);
    expect(writes).toHaveLength(1);
    expect(writes[0].notes).toContain("3 PM");
    expect(writes[0].notes).not.toContain("4 PM");
    expect(writes[0].notes.startsWith("Warm and dependable.")).toBe(true);
  });

  it("no write when nothing changes", () => {
    const grace = person("p-g", "Grace", "prefers voice notes.");
    const writes = foldPersonMemoryUpdates([{ person: grace, memory: "prefers voice notes." }], mergePersonNotes);
    expect(writes).toEqual([]);
  });
});
