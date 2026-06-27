import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Chainable Supabase mock — enough surface for carson-todos.ts's query shapes
// (.from().insert().select().single(), .from().select().eq()...order().limit(),
// .from().update().eq(), .from().delete().eq()).
// ---------------------------------------------------------------------------

interface MockState {
  insertResult: { data: unknown; error: unknown };
  selectResult: { data: unknown; error: unknown };
  updateResult: { error: unknown };
  deleteResult: { error: unknown };
}

const state: MockState = {
  insertResult: { data: null, error: null },
  selectResult: { data: [], error: null },
  updateResult: { error: null },
  deleteResult: { error: null },
};

function makeChain() {
  const chain: any = {};
  const terminal = () => Promise.resolve(state.selectResult);
  chain.eq = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => terminal());
  chain.single = vi.fn(() => Promise.resolve(state.insertResult));
  // select() after insert/update returns a chain ending in .single()
  chain.select = vi.fn(() => chain);
  return chain;
}

vi.mock("./supabase", () => ({
  supabase: {
    from: vi.fn(() => ({
      insert: vi.fn(() => makeChain()),
      select: vi.fn(() => makeChain()),
      update: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve(state.updateResult)) })),
      delete: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve(state.deleteResult)) })),
    })),
  },
}));

import {
  createTodo,
  listActiveTodos,
  completeTodo,
  formatTodosForContext,
  findTodoMatches,
  type CarsonTodo,
} from "./carson-todos";

beforeEach(() => {
  state.insertResult = { data: null, error: null };
  state.selectResult = { data: [], error: null };
  state.updateResult = { error: null };
  state.deleteResult = { error: null };
});

function todo(overrides: Partial<CarsonTodo> = {}): CarsonTodo {
  return {
    id: "t1",
    title: "Buy flowers",
    description: null,
    status: "active",
    source: "voice",
    created_at: "2026-06-27T10:00:00Z",
    updated_at: "2026-06-27T10:00:00Z",
    completed_at: null,
    ...overrides,
  };
}

describe("carson-todos: creation", () => {
  it("creates a to-do with a trimmed title", async () => {
    const row = todo();
    state.insertResult = { data: row, error: null };
    const result = await createTodo("  Buy flowers  ");
    expect(result.title).toBe("Buy flowers");
  });

  it("rejects an empty title without hitting the network", async () => {
    await expect(createTodo("   ")).rejects.toThrow();
  });

  it("surfaces a Supabase error instead of swallowing it", async () => {
    state.insertResult = { data: null, error: { message: "insert failed" } };
    await expect(createTodo("Buy flowers")).rejects.toEqual({ message: "insert failed" });
  });
});

describe("carson-todos: listing", () => {
  it("returns active to-dos from listActiveTodos", async () => {
    state.selectResult = { data: [todo(), todo({ id: "t2", title: "Renew passport" })], error: null };
    const result = await listActiveTodos();
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Buy flowers");
  });

  it("returns an empty array (not a throw) when the query errors", async () => {
    state.selectResult = { data: null, error: { message: "boom" } };
    const result = await listActiveTodos();
    expect(result).toEqual([]);
  });
});

describe("carson-todos: completion", () => {
  it("resolves without throwing when the update succeeds", async () => {
    await expect(completeTodo("t1")).resolves.toBeUndefined();
  });

  it("throws when the update fails", async () => {
    state.updateResult = { error: { message: "update failed" } };
    await expect(completeTodo("t1")).rejects.toEqual({ message: "update failed" });
  });

  it("no-ops on an empty id", async () => {
    await expect(completeTodo("   ")).resolves.toBeUndefined();
  });
});

describe("carson-todos: formatTodosForContext", () => {
  it("returns empty string when there are no active to-dos", () => {
    expect(formatTodosForContext([])).toBe("");
    expect(formatTodosForContext([todo({ status: "completed" })])).toBe("");
  });

  it("lists only active to-dos, excluding completed/archived", () => {
    const out = formatTodosForContext([
      todo({ title: "Buy flowers" }),
      todo({ id: "t2", title: "Done thing", status: "completed" }),
      todo({ id: "t3", title: "Archived thing", status: "archived" }),
    ]);
    expect(out).toContain("Buy flowers");
    expect(out).not.toContain("Done thing");
    expect(out).not.toContain("Archived thing");
    expect(out).toContain("ACTIVE TO-DOS");
  });
});

describe("carson-todos: findTodoMatches", () => {
  const list = [
    todo({ id: "t1", title: "Buy flowers for Grace" }),
    todo({ id: "t2", title: "Renew passport" }),
    todo({ id: "t3", title: "Buy birthday cake", description: "for Grace's party" }),
  ];

  it("matches case-insensitively by title", () => {
    expect(findTodoMatches(list, "FLOWERS")).toHaveLength(1);
    expect(findTodoMatches(list, "flowers")[0].id).toBe("t1");
  });

  it("matches by description as well as title", () => {
    expect(findTodoMatches(list, "grace")).toHaveLength(2);
  });

  it("returns empty array for an empty query", () => {
    expect(findTodoMatches(list, "  ")).toEqual([]);
  });

  it("returns empty array when nothing matches", () => {
    expect(findTodoMatches(list, "xyz-no-match")).toEqual([]);
  });
});
