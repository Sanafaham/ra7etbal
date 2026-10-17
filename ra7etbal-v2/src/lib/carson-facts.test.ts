/**
 * carson-facts — retrieval and correction-aware writes, against a mocked
 * Supabase client that records every call (no network).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
let factRows: Array<Record<string, unknown>> = [];
let upsertError: { message: string } | null = null;
let updateError: { message: string } | null = null;
let selectError: { message: string } | null = null;

function chain(table: string) {
  const state: { op: string } = { op: "select" };
  const c: Record<string, unknown> = {};
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ table, op, args });
    return c;
  };
  c.select = record("select");
  c.is = record("is");
  c.order = record("order");
  c.eq = record("eq");
  c.in = record("in");
  c.limit = (...args: unknown[]) => {
    calls.push({ table, op: "limit", args });
    return Promise.resolve(selectError ? { data: null, error: selectError } : { data: factRows, error: null });
  };
  c.upsert = (...args: unknown[]) => {
    calls.push({ table, op: "upsert", args });
    return Promise.resolve({ error: upsertError });
  };
  c.update = (...args: unknown[]) => {
    state.op = "update";
    calls.push({ table, op: "update", args });
    const u: Record<string, unknown> = {};
    const rec = (op: string) => (...a: unknown[]) => {
      calls.push({ table, op, args: a });
      return u;
    };
    u.eq = rec("update.eq");
    u.in = rec("update.in");
    u.is = (...a: unknown[]) => {
      calls.push({ table, op: "update.is", args: a });
      return Promise.resolve({ error: updateError });
    };
    return u;
  };
  return c;
}

vi.mock("./supabase", () => ({
  supabase: { from: vi.fn((table: string) => chain(table)) },
}));

const extractMock = vi.fn();
vi.mock("./carson-fact-extract", () => ({
  extractDurableFacts: (...args: unknown[]) => extractMock(...args),
}));

import { learnFactsFromTranscript, loadUserMemory, upsertUserFacts } from "./carson-facts";

const OWNER = "owner-a";
const PEOPLE = [{ id: "p-c", name: "Christopher" }];
const old4pm = {
  id: "f-old",
  category: "relationship",
  key: "christopher_dinner_time",
  value: "Christopher prefers dinner instructions before 4 PM.",
  updated_at: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  calls.length = 0;
  factRows = [];
  upsertError = null;
  updateError = null;
  selectError = null;
  extractMock.mockReset();
});

describe("loadUserMemory", () => {
  it("reads all active facts (not 50 alphabetical rows) and ranks Christopher's fact first when he is in context", async () => {
    factRows = [
      ...Array.from({ length: 120 }, (_, i) => ({
        id: `c-${i}`,
        category: "communication_style",
        key: `a_${String(i).padStart(3, "0")}`,
        value: `Style rule ${i}.`,
      })),
      { ...old4pm, value: "Christopher prefers dinner instructions before 3 PM." },
    ];
    const text = await loadUserMemory(60, { contextText: "Tell Christopher the dinner plan", people: PEOPLE });
    expect(text).toContain("Christopher prefers dinner instructions before 3 PM.");
    const limitCall = calls.find((c) => c.op === "limit");
    expect(limitCall?.args[0]).toBe(1000);
    expect(calls.some((c) => c.op === "is" && c.args[0] === "archived_at" && c.args[1] === null)).toBe(true);
  });

  it("returns an empty string (never throws) when the read fails", async () => {
    selectError = { message: "db down" };
    await expect(loadUserMemory()).resolves.toBe("");
  });
});

describe("upsertUserFacts — corrections", () => {
  const fact3pmNewKey = {
    category: "preference",
    key: "christopher_dinner_deadline",
    value: "Christopher prefers dinner instructions before 3 PM.",
    confidence: 0.9,
  };

  it("saves the new fact FIRST, then archives the corrected one (flag, not delete), owner-scoped", async () => {
    const res = await upsertUserFacts(OWNER, [fact3pmNewKey], { people: PEOPLE, existingFacts: [old4pm] });
    expect(res).toEqual({ saved: true, archivedIds: ["f-old"] });
    const upsertIndex = calls.findIndex((c) => c.op === "upsert");
    const updateIndex = calls.findIndex((c) => c.op === "update");
    expect(upsertIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(upsertIndex);
    expect(calls[updateIndex].args[0]).toEqual({ archived_at: expect.any(String) });
    expect(calls).toContainEqual({ table: "carson_facts", op: "update.eq", args: ["user_id", OWNER] });
    expect(calls).toContainEqual({ table: "carson_facts", op: "update.in", args: ["id", ["f-old"]] });
    expect(calls.some((c) => c.op === "delete")).toBe(false);
    const upserted = (calls[upsertIndex].args[0] as Array<Record<string, unknown>>)[0];
    expect(upserted).toMatchObject({ user_id: OWNER, archived_at: null, source: "voice_session" });
  });

  it("same key correction overwrites in place and archives nothing", async () => {
    const res = await upsertUserFacts(
      OWNER,
      [{ ...fact3pmNewKey, category: "relationship", key: "christopher_dinner_time" }],
      { people: PEOPLE, existingFacts: [old4pm] },
    );
    expect(res.archivedIds).toEqual([]);
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("if the new fact fails to save, the original is never archived", async () => {
    upsertError = { message: "write failed" };
    const res = await upsertUserFacts(OWNER, [fact3pmNewKey], { people: PEOPLE, existingFacts: [old4pm] });
    expect(res).toEqual({ saved: false, archivedIds: [] });
    expect(calls.some((c) => c.op === "update")).toBe(false);
  });

  it("if archiving fails, the save still stands and nothing throws (read-time resolution hides 4 PM)", async () => {
    updateError = { message: "update failed" };
    const res = await upsertUserFacts(OWNER, [fact3pmNewKey], { people: PEOPLE, existingFacts: [old4pm] });
    expect(res).toEqual({ saved: true, archivedIds: [] });
  });

  it("rejects an empty owner id without touching the database", async () => {
    const res = await upsertUserFacts("  ", [fact3pmNewKey]);
    expect(res.saved).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("learnFactsFromTranscript", () => {
  it("shows the extractor the related existing fact so the correction can keep its key", async () => {
    factRows = [old4pm, { id: "x", category: "language", key: "arabic", value: "Owner speaks Arabic." }];
    extractMock.mockResolvedValue([]);
    await learnFactsFromTranscript(
      OWNER,
      [{ role: "user", message: "Christopher now prefers dinner instructions before 3 PM." } as never],
      PEOPLE,
    );
    const existingPassed = extractMock.mock.calls[0][1] as Array<{ id: string }>;
    expect(existingPassed[0].id).toBe("f-old");
  });

  it("still extracts when existing facts cannot be loaded", async () => {
    selectError = { message: "db down" };
    extractMock.mockResolvedValue([]);
    const res = await learnFactsFromTranscript(OWNER, [{ role: "user", message: "hi" } as never], PEOPLE);
    expect(extractMock).toHaveBeenCalledWith(expect.any(Array), []);
    expect(res.saved).toBe(false);
  });

  it("never throws when extraction fails", async () => {
    extractMock.mockRejectedValue(new Error("model down"));
    await expect(learnFactsFromTranscript(OWNER, [], PEOPLE)).resolves.toMatchObject({ saved: false });
  });
});
