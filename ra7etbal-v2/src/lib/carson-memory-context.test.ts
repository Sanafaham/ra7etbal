/**
 * loadCarsonMemoryContext — the Talk/Type Carson session-start memory loader.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const results: Record<string, { data: unknown; error: { message: string } | null }> = {};

function chain(table: string) {
  const done = () => Promise.resolve(results[table] ?? { data: [], error: null });
  const c: Record<string, unknown> = {};
  c.select = () => c;
  c.is = () => c;
  c.order = () => (table === "carson_persistent_memory" ? done() : c);
  c.limit = () => done();
  return c;
}

vi.mock("./supabase", () => ({ supabase: { from: vi.fn((t: string) => chain(t)) } }));
vi.mock("./carson-fact-extract", () => ({ extractDurableFacts: vi.fn() }));

import { loadCarsonMemoryContext } from "./carson-memory-context";
import { loadPersistentMemory } from "./carson-persistent-memory";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
const PEOPLE = [{ id: "p-c", name: "Christopher" }];
const instr4pm = {
  id: "i-4",
  category: "general",
  instruction: "Christopher prefers receiving dinner instructions before 4 PM.",
  source: "owner_directive",
  created_at: iso(10),
  confirmed_at: iso(10),
};
const fact3pm = {
  id: "f-3",
  category: "correction",
  key: "christopher_dinner_time",
  value: "Christopher prefers dinner instructions before 3 PM.",
  updated_at: iso(1),
};

beforeEach(() => {
  for (const k of Object.keys(results)) delete results[k];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("loadCarsonMemoryContext", () => {
  it("resolves a voice-taught correction across stores: 3 PM fact replaces the 4 PM instruction", async () => {
    results.carson_persistent_memory = { data: [instr4pm], error: null };
    results.carson_facts = { data: [fact3pm], error: null };
    const ctx = await loadCarsonMemoryContext({ people: PEOPLE });
    expect(ctx.persistentInstructions).not.toContain("4 PM");
    expect(ctx.userMemory).toContain("before 3 PM");
  });

  it("facts failing to load does not lose standing instructions", async () => {
    results.carson_persistent_memory = { data: [instr4pm], error: null };
    results.carson_facts = { data: null, error: { message: "facts down" } };
    const ctx = await loadCarsonMemoryContext({ people: PEOPLE });
    expect(ctx.factsLoaded).toBe(false);
    expect(ctx.instructionsLoaded).toBe(true);
    expect(ctx.persistentInstructions).toContain("4 PM");
    expect(ctx.userMemory).toBe("");
  });

  it("instructions failing to load does not lose facts", async () => {
    results.carson_persistent_memory = { data: null, error: { message: "instructions down" } };
    results.carson_facts = { data: [fact3pm], error: null };
    const ctx = await loadCarsonMemoryContext({ people: PEOPLE, contextText: "Christopher" });
    expect(ctx.instructionsLoaded).toBe(false);
    expect(ctx.persistentInstructions).toBe("");
    expect(ctx.userMemory).toContain("before 3 PM");
  });
});

describe("loadPersistentMemory (weekly planning path)", () => {
  it("returns only the current version of a corrected instruction", async () => {
    results.carson_persistent_memory = {
      data: [instr4pm, { ...instr4pm, id: "i-3", instruction: "Christopher now prefers receiving dinner instructions before 3 PM.", created_at: iso(1) }],
      error: null,
    };
    const text = await loadPersistentMemory();
    expect(text).toContain("3 PM");
    expect(text).not.toContain("4 PM");
  });
});
