import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isSummaryWorthSaving,
  summarizeSessionRecap,
  SESSION_RECAP_PREFIX,
  type TranscriptMessage,
} from "./carson-summarize";

function mockAnthropic(text: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ content: [{ type: "text", text }] }),
    })) as unknown as typeof fetch,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session recap threshold (the bug that bit us)", () => {
  const oneTurn: TranscriptMessage[] = [{ role: "user", message: "test memory recall" }];

  it("saves a recap from a SINGLE user turn", async () => {
    mockAnthropic("Tested whether Carson remembers prior sessions.");
    const recap = await summarizeSessionRecap(oneTurn);
    expect(recap).toBeTruthy();
    expect(recap).toContain("Carson remembers");
  });

  it("returns null when there are zero user turns", async () => {
    mockAnthropic("anything");
    const recap = await summarizeSessionRecap([{ role: "agent", message: "hello" }]);
    expect(recap).toBeNull();
  });

  it("falls back to the first user utterance when the LLM call fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch,
    );
    const recap = await summarizeSessionRecap(oneTurn);
    expect(recap).toBe("test memory recall");
  });

  it("falls back when the model returns the NOTHING sentinel", async () => {
    mockAnthropic("NOTHING_MEMORABLE");
    const recap = await summarizeSessionRecap(oneTurn);
    expect(recap).toBe("test memory recall");
  });

  it("recap prefix constant is stable (loadRecentMemory depends on it)", () => {
    expect(SESSION_RECAP_PREFIX).toBe("• Session recap:");
  });
});

describe("durable memory gate stays strict (must NOT be weakened)", () => {
  it("accepts a summary with two or more bullets", () => {
    expect(isSummaryWorthSaving("• Routine: a\n• Person: b")).toBe(true);
  });

  it("accepts a single durable correction/preference bullet", () => {
    expect(isSummaryWorthSaving("• Correction: it's Loulya, not Lula")).toBe(true);
    expect(isSummaryWorthSaving("• Preference: user prefers brief answers")).toBe(true);
  });

  it("rejects a single thin non-durable bullet", () => {
    expect(isSummaryWorthSaving("• Discussed dinner logistics for tonight")).toBe(false);
  });

  it("rejects empty/blank summaries", () => {
    expect(isSummaryWorthSaving("")).toBe(false);
    expect(isSummaryWorthSaving("   ")).toBe(false);
  });
});
