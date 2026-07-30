import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSessionRecapWithActions,
  formatSessionActionsForRecap,
  isSummaryWorthSaving,
  sanitizeTranscriptForDurableMemory,
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
    expect(SESSION_RECAP_PREFIX).toBe("• Verified session recap:");
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

  it("does not persist a promise to organize dinner when execution fails", () => {
    const safe = sanitizeTranscriptForDurableMemory([
      { role: "user", message: "I have dinner tomorrow. Handle it." },
      { role: "agent", message: "I'll organize dinner." },
    ]);

    expect(safe.transcript).toEqual([
      { role: "user", message: "I have dinner tomorrow. Handle it." },
    ]);
    expect(
      buildSessionRecapWithActions(
        "Discussed dinner tomorrow.",
        [],
        safe.removedOperationalClaims,
      ),
    ).toBe(
      "Discussed dinner tomorrow.\nOperational outcome: no execution was verified.",
    );
  });

  it("removes unsupported staff-delivery claims from all transcript-derived memory", () => {
    const safe = sanitizeTranscriptForDurableMemory([
      { role: "user", message: "Please tell Christopher." },
      { role: "agent", message: "Christopher has been informed." },
      { role: "user", message: "Thank you." },
    ]);

    expect(safe.transcript.map((message) => message.message)).not.toContain(
      "Christopher has been informed.",
    );
    expect(safe.removedOperationalClaims).toBe(1);
  });

  it("removes unsupported multi-person claims seen in contaminated production memory", () => {
    const safe = sanitizeTranscriptForDurableMemory([
      { role: "user", message: "I have dinner at home tomorrow." },
      {
        role: "agent",
        message: "Christopher and Grace were briefed earlier tonight.",
      },
    ]);

    expect(safe.removedOperationalClaims).toBe(1);
    expect(safe.transcript).toHaveLength(1);
  });

  it("records non-execution after a rejected promise instead of the promise", () => {
    const safe = sanitizeTranscriptForDurableMemory([
      { role: "agent", message: "I'll send that now." },
      { role: "agent", message: "I need to know who should handle it." },
    ]);
    const recap = buildSessionRecapWithActions(
      "More information was required.",
      [],
      safe.removedOperationalClaims,
    );

    expect(recap).not.toContain("send that now");
    expect(recap).toContain("no execution was verified");
  });

  it("records verified handler actions as the only operational completion evidence", () => {
    const safe = sanitizeTranscriptForDurableMemory([
      { role: "user", message: "Tell Christopher dinner is at seven." },
      { role: "agent", message: "I've sent it to Christopher." },
    ]);
    const recap = buildSessionRecapWithActions(
      "Discussed dinner timing.",
      ["Sent WhatsApp to Christopher: Dinner is at seven."],
      safe.removedOperationalClaims,
    );

    expect(recap).toContain(
      "* Sent WhatsApp to Christopher: Dinner is at seven.",
    );
    expect(recap).not.toContain("no execution was verified");
    expect(recap).not.toContain("I've sent it");
  });

  it("rejects an unsupported operational claim generated by the recap model itself", () => {
    expect(
      buildSessionRecapWithActions(
        "Christopher and Grace were briefed earlier tonight.",
        [],
        1,
      ),
    ).toBe("Operational outcome: no execution was verified.");
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

  it("does not accept unsupported execution text returned by the durable summarizer", async () => {
    mockAnthropic(
      [
        "• Christopher has been informed.",
        "• Grace was notified.",
      ].join("\n"),
    );

    const summary = await summarizeConversation([
      { role: "user", message: "Please tell the staff about dinner." },
      { role: "user", message: "They need the time." },
    ]);

    expect(summary).toBeNull();
  });
});
