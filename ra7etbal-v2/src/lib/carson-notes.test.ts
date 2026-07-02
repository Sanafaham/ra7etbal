import { describe, expect, it, vi } from "vitest";

// carson-notes.ts imports ./supabase, which throws at module load without
// VITE_SUPABASE_* env vars. Stub it — these tests only exercise the pure
// findNoteMatches function, never anything that talks to Supabase. Same
// pattern as carson-todos.test.ts.
vi.mock("./supabase", () => ({ supabase: {} }));

import { findNoteMatches, type CarsonNote } from "./carson-notes";

function note(overrides: Partial<CarsonNote> = {}): CarsonNote {
  return {
    id: "n1",
    note: "Boxed pearl keychains — stored in closet",
    category: "general",
    source: "voice",
    created_at: "2026-07-03T10:00:00Z",
    updated_at: "2026-07-03T10:00:00Z",
    ...overrides,
  };
}

describe("findNoteMatches", () => {
  it("matches an existing note that contains the query text", () => {
    const notes = [note({ id: "a", note: "Compare Gemini plan with Claude plan" })];
    expect(findNoteMatches(notes, "Compare Gemini plan with Claude plan")).toHaveLength(1);
  });

  it("matches when the query is a superset of a shorter existing note (either direction)", () => {
    const notes = [note({ id: "a", note: "Gemini plan" })];
    expect(findNoteMatches(notes, "Compare the Gemini plan with Claude's")).toHaveLength(1);
  });

  it("is case-insensitive", () => {
    const notes = [note({ id: "a", note: "Call the vet" })];
    expect(findNoteMatches(notes, "CALL THE VET")).toHaveLength(1);
  });

  it("returns an empty array when nothing matches", () => {
    const notes = [note({ id: "a", note: "Unrelated idea" })];
    expect(findNoteMatches(notes, "Call the vet")).toEqual([]);
  });

  it("returns an empty array for a blank query", () => {
    const notes = [note({ id: "a" })];
    expect(findNoteMatches(notes, "   ")).toEqual([]);
  });

  it("returns an empty array when there are no notes", () => {
    expect(findNoteMatches([], "anything")).toEqual([]);
  });
});
