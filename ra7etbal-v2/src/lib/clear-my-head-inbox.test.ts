import { describe, expect, it, vi, beforeEach } from "vitest";

// Chainable Supabase mock covering clear-my-head-inbox.ts's query shapes:
//   .from().insert(obj).select(cols).single()   (saveClearMyHeadInboxItem)
//   .from().insert(rows).select(cols)           (saveClearMyHeadInboxItems — awaited directly, no .single())
//   .from().select(cols).order().limit()        (listClearMyHeadInboxItems)
//   .from().delete().eq()                        (deleteClearMyHeadInboxItem)

interface MockState {
  singleInsertResult: { data: unknown; error: unknown };
  batchInsertResult: { data: unknown; error: unknown };
  selectResult: { data: unknown; error: unknown };
  deleteResult: { error: unknown };
}

const state: MockState = {
  singleInsertResult: { data: null, error: null },
  batchInsertResult: { data: [], error: null },
  selectResult: { data: [], error: null },
  deleteResult: { error: null },
};

function makeSelectAfterInsertChain() {
  const batchPromise = Promise.resolve(state.batchInsertResult);
  return {
    single: vi.fn(() => Promise.resolve(state.singleInsertResult)),
    then: (onFulfilled: any, onRejected: any) => batchPromise.then(onFulfilled, onRejected),
  };
}

function makeListChain() {
  const chain: any = {};
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(state.selectResult));
  return chain;
}

const fromMock = vi.fn((_table: string) => ({
  insert: vi.fn(() => ({ select: vi.fn(() => makeSelectAfterInsertChain()) })),
  select: vi.fn(() => makeListChain()),
  delete: vi.fn(() => ({ eq: vi.fn(() => Promise.resolve(state.deleteResult)) })),
}));

vi.mock("./supabase", () => ({
  supabase: { from: (table: string) => fromMock(table) },
}));

import {
  saveClearMyHeadInboxItem,
  saveClearMyHeadInboxItems,
  listClearMyHeadInboxItems,
  deleteClearMyHeadInboxItem,
  type ClearMyHeadInboxItem,
} from "./clear-my-head-inbox";

beforeEach(() => {
  vi.clearAllMocks();
  state.singleInsertResult = { data: null, error: null };
  state.batchInsertResult = { data: [], error: null };
  state.selectResult = { data: [], error: null };
  state.deleteResult = { error: null };
});

function item(overrides: Partial<ClearMyHeadInboxItem> = {}): ClearMyHeadInboxItem {
  return {
    id: "i1",
    text: "Buy flowers for Grace",
    created_at: "2026-07-03T10:00:00Z",
    ...overrides,
  };
}

describe("saveClearMyHeadInboxItem", () => {
  it("saves a single trimmed thought", async () => {
    const row = item();
    state.singleInsertResult = { data: row, error: null };
    const result = await saveClearMyHeadInboxItem("  Buy flowers for Grace  ");
    expect(result).toEqual(row);
  });

  it("throws rather than saving an empty/whitespace-only thought", async () => {
    await expect(saveClearMyHeadInboxItem("   ")).rejects.toThrow();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("propagates a Supabase error", async () => {
    state.singleInsertResult = { data: null, error: { message: "insert failed" } };
    await expect(saveClearMyHeadInboxItem("A thought")).rejects.toEqual({ message: "insert failed" });
  });
});

describe("saveClearMyHeadInboxItems", () => {
  it("saves multiple thoughts in one call, trimming each", async () => {
    const rows = [item({ id: "a", text: "First" }), item({ id: "b", text: "Second" })];
    state.batchInsertResult = { data: rows, error: null };
    const result = await saveClearMyHeadInboxItems(["  First  ", "Second"]);
    expect(result).toEqual(rows);
  });

  it("drops blank entries before saving", async () => {
    state.batchInsertResult = { data: [item()], error: null };
    await saveClearMyHeadInboxItems(["Buy flowers for Grace", "   ", ""]);
    expect(fromMock).toHaveBeenCalledWith("clear_my_head_inbox");
  });

  it("is a no-op (never calls Supabase) when every entry is blank", async () => {
    const result = await saveClearMyHeadInboxItems(["", "   "]);
    expect(result).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty list", async () => {
    const result = await saveClearMyHeadInboxItems([]);
    expect(result).toEqual([]);
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("propagates a Supabase error for the whole batch (all-or-nothing)", async () => {
    state.batchInsertResult = { data: null, error: { message: "batch insert failed" } };
    await expect(saveClearMyHeadInboxItems(["First", "Second"])).rejects.toEqual({
      message: "batch insert failed",
    });
  });
});

describe("listClearMyHeadInboxItems", () => {
  it("returns items newest-first", async () => {
    const rows = [item({ id: "a" }), item({ id: "b" })];
    state.selectResult = { data: rows, error: null };
    const result = await listClearMyHeadInboxItems();
    expect(result).toEqual(rows);
  });

  it("returns an empty array (never throws) on a read error", async () => {
    state.selectResult = { data: null, error: { message: "read failed" } };
    const result = await listClearMyHeadInboxItems();
    expect(result).toEqual([]);
  });
});

describe("deleteClearMyHeadInboxItem", () => {
  it("deletes by id", async () => {
    await expect(deleteClearMyHeadInboxItem("i1")).resolves.toBeUndefined();
  });

  it("is a no-op for a blank id", async () => {
    await deleteClearMyHeadInboxItem("   ");
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("throws on a Supabase error (write path)", async () => {
    state.deleteResult = { error: { message: "delete failed" } };
    await expect(deleteClearMyHeadInboxItem("i1")).rejects.toEqual({ message: "delete failed" });
  });
});
