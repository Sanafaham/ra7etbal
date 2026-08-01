/**
 * Tests for Memory Governance write gate integration in carson-persistent-memory.
 *
 * COS Ch. 19.4: Only Epistemic Governance may write new beliefs to Memory.
 * savePersistentInstruction() is the sole write path — it must route through
 * validateMemoryWrite() before any DB insert.
 *
 * Covers:
 * - Gate rejection: ephemeral task thrown to caller with descriptive message
 * - Gate rejection: empty instruction thrown to caller
 * - Gate pass: valid durable rule proceeds to DB insert
 * - DB error propagates correctly
 * - loadPersistentMemory: recent instructions have no stale label
 * - loadPersistentMemory: old instructions carry stale suffix
 * - loadPersistentMemory: empty table returns empty string
 * - loadPersistentMemory: DB error returns empty string
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock supabase before importing the module under test
vi.mock("./supabase", () => ({
  supabase: {
    from: vi.fn(),
    auth: { getUser: vi.fn() },
  },
}));

import { supabase } from "./supabase";
import { savePersistentInstruction, loadPersistentMemory } from "./carson-persistent-memory";
import { MEMORY_STALE_THRESHOLD_DAYS } from "./carson-epistemic-gate";

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function mockChain(result: { data?: unknown; error?: { message: string } | null }) {
  const chain = { select: vi.fn(), order: vi.fn(), insert: vi.fn(), limit: vi.fn() };
  chain.select.mockReturnValue(chain);
  // order() is the terminal call for loadPersistentMemory
  chain.order.mockReturnValue(Promise.resolve(result));
  // limit() is terminal for loadRecentMemory (not tested here but mocked for safety)
  chain.limit.mockReturnValue(Promise.resolve(result));
  chain.insert.mockReturnValue(Promise.resolve(result));
  (supabase.from as ReturnType<typeof vi.fn>).mockReturnValue(chain);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// savePersistentInstruction — gate enforcement
// ---------------------------------------------------------------------------

describe("savePersistentInstruction — gate enforcement", () => {
  it("throws with a descriptive message when instruction is empty", async () => {
    await expect(savePersistentInstruction("general", "")).rejects.toThrow(
      "too short",
    );
  });

  it("throws with an ephemeral-task message when the instruction looks like a one-off task", async () => {
    await expect(
      savePersistentInstruction("general", "remind me at 3pm to call Grace"),
    ).rejects.toThrow("one-time task");
  });

  it("does NOT insert to DB when the gate rejects", async () => {
    const chain = mockChain({ data: null, error: null });
    try {
      await savePersistentInstruction("general", "");
    } catch {
      // expected
    }
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it("inserts to DB with provenance fields when the gate passes", async () => {
    const chain = mockChain({ data: null, error: null });
    await savePersistentInstruction("always", "always ask before delegating");
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "always",
        instruction: "always ask before delegating",
        source: "owner_directive",
        confirmed_at: expect.any(String),
      }),
    );
  });

  it("propagates DB errors after a successful gate pass", async () => {
    mockChain({ data: null, error: { message: "db error" } });
    await expect(
      savePersistentInstruction("always", "always confirm before sending"),
    ).rejects.toMatchObject({ message: "db error" });
  });
});

// ---------------------------------------------------------------------------
// loadPersistentMemory — freshness injection
// ---------------------------------------------------------------------------

describe("loadPersistentMemory — freshness injection", () => {
  it("returns empty string on DB error", async () => {
    mockChain({ data: null, error: { message: "db error" } });
    const result = await loadPersistentMemory();
    expect(result).toBe("");
  });

  it("returns empty string when there are no rows", async () => {
    mockChain({ data: [], error: null });
    const result = await loadPersistentMemory();
    expect(result).toBe("");
  });

  it("includes the instruction header with at least one row", async () => {
    mockChain({
      data: [
        { category: "always", instruction: "always confirm before acting", confirmed_at: daysAgoIso(1) },
      ],
      error: null,
    });
    const result = await loadPersistentMemory();
    expect(result).toContain("Persistent instructions");
    expect(result).toContain("always confirm before acting");
  });

  it("does NOT add stale label for a recent instruction", async () => {
    mockChain({
      data: [
        { category: "preference", instruction: "keep it short", confirmed_at: daysAgoIso(5) },
      ],
      error: null,
    });
    const result = await loadPersistentMemory();
    expect(result).not.toContain("stale");
    expect(result).not.toContain("re-confirmation");
  });

  it("adds a stale label for an old instruction", async () => {
    const oldDate = daysAgoIso(MEMORY_STALE_THRESHOLD_DAYS + 10);
    mockChain({
      data: [
        { category: "preference", instruction: "keep it short", confirmed_at: oldDate },
      ],
      error: null,
    });
    const result = await loadPersistentMemory();
    expect(result).toContain("re-confirmation");
    expect(result).toContain("keep it short");
  });

  it("mixes stale and fresh instructions correctly", async () => {
    const oldDate = daysAgoIso(MEMORY_STALE_THRESHOLD_DAYS + 10);
    const recentDate = daysAgoIso(3);
    mockChain({
      data: [
        { category: "always", instruction: "always confirm", confirmed_at: oldDate },
        { category: "never", instruction: "never say one moment", confirmed_at: recentDate },
      ],
      error: null,
    });
    const result = await loadPersistentMemory();
    expect(result).toContain("always confirm");
    expect(result).toContain("never say one moment");
    // Only the old one is stale
    const lines = result.split("\n").filter((l) => l.startsWith("-"));
    expect(lines[0]).toContain("re-confirmation");
    expect(lines[1]).not.toContain("re-confirmation");
  });
});
