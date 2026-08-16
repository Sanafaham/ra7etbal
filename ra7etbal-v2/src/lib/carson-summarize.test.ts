import { describe, it, expect, vi, afterEach } from "vitest";

// carson-summarize.ts calls the Anthropic model through the shared,
// authenticated callAnthropicProxy() helper (src/lib/anthropic-client.ts),
// not a raw fetch("/api/anthropic") anymore. These tests exercise
// carson-summarize.ts's own recap/summarization logic, not the proxy's auth
// contract (covered separately in anthropic-client.test.ts and
// api/anthropic.test.js), so the mock boundary is the helper itself.
const callAnthropicProxyMock = vi.fn();
vi.mock("./anthropic-client", () => ({
  callAnthropicProxy: (...args: unknown[]) => callAnthropicProxyMock(...args),
}));

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
  callAnthropicProxyMock.mockResolvedValue({
    ok: true,
    json: async () => ({ content: [{ type: "text", text }] }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  callAnthropicProxyMock.mockReset();
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
    callAnthropicProxyMock.mockResolvedValue({ ok: false, json: async () => ({}) });
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

  // Regression guard for the "blue pen" production incident: this LLM call
  // has no access to verified tool output, so it must never save a recap
  // that asserts a specific operational outcome — that shape of memory was
  // recalled in a later session and answered a Commitment History question
  // directly, even though the live prompt explicitly forbade using
  // recent_memory for that. Falls back to the safe, topic-only heuristic
  // instead of saving the LLM's unverified narrative verbatim.
  it("falls back instead of saving a recap that asserts a specific operational outcome", async () => {
    mockAnthropic(
      "Carson explained that Christopher purchased a blue pen on August 2nd at 6:12 PM.",
    );
    const recap = await summarizeSessionRecap(oneTurn);
    expect(recap).toBe("test memory recall");
    expect(recap).not.toContain("blue pen");
    expect(recap).not.toContain("6:12");
  });

  it("still saves a genuine topic-only recap that contains no operational claim", async () => {
    mockAnthropic("Discussed weekend plans and reviewed the household budget.");
    const recap = await summarizeSessionRecap(oneTurn);
    expect(recap).toBe("Discussed weekend plans and reviewed the household budget.");
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
