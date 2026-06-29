import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSessionRecapWithActions,
  formatSessionActionsForRecap,
  isSummaryWorthSaving,
  summarizeConversation,
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

  it("session action recap includes delegated person names and task text", () => {
    const actions = formatSessionActionsForRecap([
      "Delegated to Ghulam: have the cars clean and ready by 8 AM",
      "Delegated to Grace: send the flower inventory.",
    ]);

    expect(actions).toBe(
      [
        "Session actions:",
        "* Delegated to Ghulam: have the cars clean and ready by 8 AM.",
        "* Delegated to Grace: send the flower inventory.",
      ].join("\n"),
    );
  });

  it("session recap includes reminders and calendar actions when present", () => {
    const recap = buildSessionRecapWithActions("Handled planning requests.", [
      "Created reminder: call insurance (Tomorrow at 10:00 AM)",
      "Created calendar event: lunch (Tuesday at 2:00 PM)",
    ]);

    expect(recap).toContain("Handled planning requests.");
    expect(recap).toContain("* Created reminder: call insurance (Tomorrow at 10:00 AM).");
    expect(recap).toContain("* Created calendar event: lunch (Tuesday at 2:00 PM).");
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

  it("does not store one-time delegation actions as durable memory", async () => {
    mockAnthropic(
      [
        "• Delegated to Ghulam to have the cars clean and ready by 8 AM.",
        "• Sent Grace the flower inventory task.",
      ].join("\n"),
    );

    const summary = await summarizeConversation([
      { role: "user", message: "Ask Ghulam to have the cars clean and ready by 8 AM." },
      { role: "agent", message: "Sent." },
      { role: "user", message: "Ask Grace to send the flower inventory." },
    ]);

    expect(summary).toBeNull();
  });
});
