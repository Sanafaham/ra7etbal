import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CarsonNote } from "./carson-notes";
import type { CarsonTodo } from "./carson-todos";

const mocks = vi.hoisted(() => ({
  loadUnresolvedNotes: vi.fn(),
  listActiveTodosWithSurfaceState: vi.fn(),
}));

vi.mock("./carson-notes", () => ({ loadUnresolvedNotes: mocks.loadUnresolvedNotes }));
vi.mock("./carson-todos", () => ({ listActiveTodosWithSurfaceState: mocks.listActiveTodosWithSurfaceState }));

const { fetchUnresolvedCaptureCandidates, classifyAttentionWorthyCaptures } = await import(
  "./carson-unresolved-captures"
);

const NOW = new Date("2026-08-24T12:00:00.000Z");

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function makeNote(overrides: Partial<CarsonNote> = {}): CarsonNote {
  return {
    id: "note-1",
    note: "Check on Nimala's wedding invitation",
    category: "general",
    source: "voice",
    created_at: daysAgo(60),
    updated_at: daysAgo(60),
    dismissed_at: null,
    last_surfaced_at: null,
    ...overrides,
  };
}

function makeTodo(overrides: Partial<CarsonTodo> = {}): CarsonTodo {
  return {
    id: "todo-1",
    title: "Review the Rahet Bal home screen",
    description: null,
    status: "active",
    source: "voice",
    created_at: daysAgo(45),
    updated_at: daysAgo(45),
    completed_at: null,
    last_surfaced_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadUnresolvedNotes.mockResolvedValue([]);
  mocks.listActiveTodosWithSurfaceState.mockResolvedValue([]);
});

describe("fetchUnresolvedCaptureCandidates — retrieval only, no classification", () => {
  it("returns every unresolved note and active todo, unfiltered", async () => {
    mocks.loadUnresolvedNotes.mockResolvedValue([
      makeNote({ id: "n1", note: "Restaurant I liked in Paris" }), // reference-style — retrieval still returns it
    ]);
    mocks.listActiveTodosWithSurfaceState.mockResolvedValue([makeTodo({ id: "t1" })]);

    const candidates = await fetchUnresolvedCaptureCandidates(NOW);
    expect(candidates).toHaveLength(2);
    expect(candidates.find((c) => c.id === "n1")).toBeTruthy();
    expect(candidates.find((c) => c.id === "t1")).toBeTruthy();
  });

  it("computes ageDays and neverSurfaced correctly", async () => {
    mocks.loadUnresolvedNotes.mockResolvedValue([
      makeNote({ id: "n1", created_at: daysAgo(30), last_surfaced_at: null }),
      makeNote({ id: "n2", created_at: daysAgo(5), last_surfaced_at: daysAgo(1) }),
    ]);
    const candidates = await fetchUnresolvedCaptureCandidates(NOW);
    const n1 = candidates.find((c) => c.id === "n1")!;
    const n2 = candidates.find((c) => c.id === "n2")!;
    expect(n1.ageDays).toBe(30);
    expect(n1.neverSurfaced).toBe(true);
    expect(n2.ageDays).toBe(5);
    expect(n2.neverSurfaced).toBe(false);
  });
});

describe("classification — action-oriented wording heuristic (notes only; todos always actionable)", () => {
  it("marks an unresolved, action-led note as actionable", async () => {
    mocks.loadUnresolvedNotes.mockResolvedValue([makeNote({ note: "Check on Nimala's wedding invitation" })]);
    const candidates = await fetchUnresolvedCaptureCandidates(NOW);
    expect(candidates[0].actionable).toBe(true);
  });

  it("marks 'Renew passport' as actionable", async () => {
    mocks.loadUnresolvedNotes.mockResolvedValue([makeNote({ note: "Renew passport" })]);
    const candidates = await fetchUnresolvedCaptureCandidates(NOW);
    expect(candidates[0].actionable).toBe(true);
  });

  it("does not mark a reference-style note as actionable", async () => {
    mocks.loadUnresolvedNotes.mockResolvedValue([makeNote({ note: "Restaurant I liked in Paris." })]);
    const candidates = await fetchUnresolvedCaptureCandidates(NOW);
    expect(candidates[0].actionable).toBe(false);
  });

  it("does not mark a product-idea note as actionable", async () => {
    mocks.loadUnresolvedNotes.mockResolvedValue([
      makeNote({ note: "Want Carson to be able to initiate calls within the app at some point." }),
    ]);
    const candidates = await fetchUnresolvedCaptureCandidates(NOW);
    expect(candidates[0].actionable).toBe(false);
  });

  it("a to-do is always actionable regardless of wording", async () => {
    mocks.listActiveTodosWithSurfaceState.mockResolvedValue([makeTodo({ title: "Build a flight simulator with Claude code" })]);
    const candidates = await fetchUnresolvedCaptureCandidates(NOW);
    expect(candidates[0].actionable).toBe(true);
  });
});

describe("classifyAttentionWorthyCaptures — pure, deterministic, bounded", () => {
  it("excludes non-actionable notes even when old", () => {
    const candidates = [
      { id: "n1", kind: "note" as const, text: "Restaurant I liked in Paris", ageDays: 200, neverSurfaced: true, actionable: false },
    ];
    expect(classifyAttentionWorthyCaptures(candidates)).toEqual([]);
  });

  it("includes actionable, never-surfaced items", () => {
    const candidates = [
      { id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60, neverSurfaced: true, actionable: true },
    ];
    const result = classifyAttentionWorthyCaptures(candidates);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("n1");
  });

  it("excludes items already surfaced before, even if actionable", () => {
    const candidates = [
      { id: "n1", kind: "note" as const, text: "Check on Nimala's wedding invitation", ageDays: 60, neverSurfaced: false, actionable: true },
    ];
    expect(classifyAttentionWorthyCaptures(candidates)).toEqual([]);
  });

  it("does not use age alone to include a fresh actionable item over an old non-actionable one — age is a tie-break, not a gate", () => {
    const fresh = { id: "fresh", kind: "note" as const, text: "Renew passport", ageDays: 1, neverSurfaced: true, actionable: true };
    const old = { id: "old", kind: "note" as const, text: "Restaurant I liked in Paris", ageDays: 300, neverSurfaced: true, actionable: false };
    const result = classifyAttentionWorthyCaptures([old, fresh]);
    expect(result.map((c) => c.id)).toEqual(["fresh"]);
  });

  it("orders eligible candidates oldest-first", () => {
    const a = { id: "a", kind: "todo" as const, text: "A", ageDays: 5, neverSurfaced: true, actionable: true };
    const b = { id: "b", kind: "todo" as const, text: "B", ageDays: 40, neverSurfaced: true, actionable: true };
    const c = { id: "c", kind: "todo" as const, text: "C", ageDays: 20, neverSurfaced: true, actionable: true };
    const result = classifyAttentionWorthyCaptures([a, b, c]);
    expect(result.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });

  it("bounds output to maxItems even when more are eligible (noise control)", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      kind: "todo" as const,
      text: `Todo ${i}`,
      ageDays: i,
      neverSurfaced: true,
      actionable: true,
    }));
    const result = classifyAttentionWorthyCaptures(candidates, 3);
    expect(result).toHaveLength(3);
  });
});
