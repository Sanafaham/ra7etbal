/**
 * Tests for the Memory Governance Epistemic Gate (COS Ch. 19.4).
 *
 * Covers:
 * - Write gate: valid instruction → passes with correct payload
 * - Write gate: invalid inputs → rejected with reason
 * - Write gate: ephemeral task patterns → rejected
 * - Write gate: durable rule patterns → pass
 * - Freshness evaluation: stale persistent instruction detection
 * - Freshness evaluation: session recap age detection
 * - Provenance: payload carries correct source and confidence
 */

import { describe, it, expect } from "vitest";
import {
  validateMemoryWrite,
  isPersistentMemoryStale,
  isSessionRecapOld,
  daysSince,
  MEMORY_STALE_THRESHOLD_DAYS,
  SESSION_STALE_THRESHOLD_DAYS,
} from "./carson-epistemic-gate";

// ---------------------------------------------------------------------------
// Write gate — valid inputs
// ---------------------------------------------------------------------------

describe("validateMemoryWrite — valid inputs", () => {
  it("accepts a standard durable rule", () => {
    const result = validateMemoryWrite({
      instruction: "always ask before delegating to Christopher",
      category: "always",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.instruction).toBe("always ask before delegating to Christopher");
    expect(result.payload.category).toBe("always");
    expect(result.payload.source).toBe("owner_directive");
    expect(result.payload.confidence).toBe("high");
    expect(result.payload.confirmed_at).toBeTruthy();
  });

  it("trims whitespace from instruction and category", () => {
    const result = validateMemoryWrite({
      instruction: "  never say 'one moment'  ",
      category: "  never  ",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.instruction).toBe("never say 'one moment'");
    expect(result.payload.category).toBe("never");
  });

  it("defaults category to 'general' when blank", () => {
    const result = validateMemoryWrite({ instruction: "keep responses short", category: "" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.category).toBe("general");
  });

  it("assigns medium confidence for session_inference source", () => {
    const result = validateMemoryWrite({
      instruction: "prefers concise updates",
      category: "preference",
      source: "session_inference",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.confidence).toBe("medium");
  });

  it("sets confirmed_at to a valid ISO timestamp", () => {
    const before = new Date().toISOString();
    const result = validateMemoryWrite({ instruction: "from now on use bullet points", category: "preference" });
    const after = new Date().toISOString();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.confirmed_at >= before).toBe(true);
    expect(result.payload.confirmed_at <= after).toBe(true);
  });

  it("accepts a long but within-limit instruction", () => {
    const instruction = "a".repeat(200);
    const result = validateMemoryWrite({ instruction, category: "general" });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Write gate — rejection cases
// ---------------------------------------------------------------------------

describe("validateMemoryWrite — rejections", () => {
  it("rejects empty instruction", () => {
    const result = validateMemoryWrite({ instruction: "", category: "general" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("instruction_too_short");
  });

  it("rejects whitespace-only instruction", () => {
    const result = validateMemoryWrite({ instruction: "   ", category: "general" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("instruction_too_short");
  });

  it("rejects single character instruction", () => {
    const result = validateMemoryWrite({ instruction: "X", category: "general" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("instruction_too_short");
  });

  it("rejects instruction exceeding 2000 bytes", () => {
    const instruction = "a".repeat(2001);
    const result = validateMemoryWrite({ instruction, category: "general" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("instruction_too_long");
  });
});

// ---------------------------------------------------------------------------
// Write gate — ephemeral task detection
// ---------------------------------------------------------------------------

describe("validateMemoryWrite — ephemeral task rejection", () => {
  const ephemeralInputs = [
    "remind me at 3pm to call Grace",
    "remind me in 10 minutes about the meeting",
    "remind me to buy flowers today",
    "call Grace today",
    "text Christopher tonight",
    "buy flowers today",
    "get milk this week",
    "finish the report asap",
    "send the invoice today",
  ];

  for (const instruction of ephemeralInputs) {
    it(`rejects ephemeral task: "${instruction}"`, () => {
      const result = validateMemoryWrite({ instruction, category: "general" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("ephemeral_task_not_a_rule");
    });
  }
});

describe("validateMemoryWrite — durable rules pass", () => {
  const durableInputs = [
    "always ask before delegating",
    "never use the word tasks",
    "from now on keep responses under two sentences",
    "don't add commentary after successful delegations",
    "use Arabic when I speak Arabic",
    "always confirm event time before creating calendar entries",
  ];

  for (const instruction of durableInputs) {
    it(`passes durable rule: "${instruction}"`, () => {
      const result = validateMemoryWrite({ instruction, category: "general" });
      expect(result.ok).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Freshness evaluation
// ---------------------------------------------------------------------------

describe("isPersistentMemoryStale", () => {
  it("returns false for a recent timestamp", () => {
    const recent = new Date().toISOString();
    expect(isPersistentMemoryStale(recent)).toBe(false);
  });

  it("returns false for an instruction confirmed yesterday", () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(isPersistentMemoryStale(yesterday)).toBe(false);
  });

  it("returns true for an instruction older than the stale threshold", () => {
    const old = new Date(
      Date.now() - (MEMORY_STALE_THRESHOLD_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(isPersistentMemoryStale(old)).toBe(true);
  });

  it("returns false at exactly the threshold boundary", () => {
    const boundary = new Date(
      Date.now() - MEMORY_STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000 + 1000,
    ).toISOString();
    expect(isPersistentMemoryStale(boundary)).toBe(false);
  });
});

describe("isSessionRecapOld", () => {
  it("returns false for a recent session", () => {
    const recent = new Date().toISOString();
    expect(isSessionRecapOld(recent)).toBe(false);
  });

  it("returns true for a session older than the threshold", () => {
    const old = new Date(
      Date.now() - (SESSION_STALE_THRESHOLD_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(isSessionRecapOld(old)).toBe(true);
  });
});

describe("daysSince", () => {
  it("returns 0 for a timestamp just now", () => {
    expect(daysSince(new Date().toISOString())).toBe(0);
  });

  it("returns the correct number of whole days", () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(daysSince(threeDaysAgo)).toBe(3);
  });
});
