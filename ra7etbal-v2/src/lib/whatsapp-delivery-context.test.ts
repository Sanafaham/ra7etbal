import { describe, it, expect, vi } from "vitest";

// whatsapp-delivery-context.ts imports ./supabase at module top level, which
// throws without VITE_SUPABASE_* env vars. We only test the pure formatter
// (buildWhatsappDeliveryStatusBlock) here, so stub the client.
vi.mock("./supabase", () => ({ supabase: {} }));

const { buildWhatsappDeliveryStatusBlock } = await import("./whatsapp-delivery-context");
import type { WhatsappDeliveryFailureSummary } from "./whatsapp-delivery-context";

function makeFailure(overrides: Partial<WhatsappDeliveryFailureSummary> = {}): WhatsappDeliveryFailureSummary {
  return {
    recipientName: "Sana",
    sourceType: "automation_message",
    failureReason: "In order to maintain a healthy ecosystem engagement, the message failed to be delivered.",
    failureCode: null,
    failedAgoMs: 2 * 3_600_000,
    ...overrides,
  };
}

describe("buildWhatsappDeliveryStatusBlock", () => {
  it("returns an empty string when there are no failures", () => {
    expect(buildWhatsappDeliveryStatusBlock([])).toBe("");
  });

  it("renders recipient, age, and reason for a single failure", () => {
    const block = buildWhatsappDeliveryStatusBlock([makeFailure()]);
    expect(block).toContain("WHATSAPP DELIVERY ISSUES");
    expect(block).toContain("Sana");
    expect(block).toContain("2h ago");
    expect(block).toContain("ecosystem engagement");
  });

  it("caps the list at 5 and notes how many were omitted", () => {
    const failures = Array.from({ length: 8 }, (_, i) => makeFailure({ recipientName: `Person${i}` }));
    const block = buildWhatsappDeliveryStatusBlock(failures);
    expect(block).toContain("(showing 5 of 8 failures)");
  });

  it("handles a missing recipient name gracefully", () => {
    const block = buildWhatsappDeliveryStatusBlock([makeFailure({ recipientName: null })]);
    expect(block).toContain("Failed —");
    expect(block).not.toContain("to null");
  });

  // Production bug: this block sat in Carson's context for a whole session
  // and got attached, unprompted, to an unrelated successful send ("Given
  // the recent delivery issues, I'd recommend calling him directly").
  // Requirement: only mention when asked, never editorialize/recommend.
  it("carries an explicit usage guardrail so Carson doesn't volunteer it or recommend contacting someone directly", () => {
    const block = buildWhatsappDeliveryStatusBlock([makeFailure()]);
    expect(block).toMatch(/background only/i);
    expect(block).toMatch(/do not mention unless the user asks/i);
    expect(block).toMatch(/never use this to recommend contacting someone directly/i);
  });

  it("still reports real per-recipient failure data accurately (the guardrail hides nothing when Carson legitimately needs it)", () => {
    const block = buildWhatsappDeliveryStatusBlock([
      makeFailure({ recipientName: "Ghulam", failedAgoMs: 20 * 3_600_000 }),
    ]);
    expect(block).toContain("Ghulam");
    expect(block).toContain("20h ago");
  });

  it("attributes each failure to its own recipient — one recipient's failures are never merged into another's line", () => {
    const block = buildWhatsappDeliveryStatusBlock([
      makeFailure({ recipientName: "Ghulam", failureReason: "reason A" }),
      makeFailure({ recipientName: "Nasira", failureReason: "reason B" }),
    ]);
    const ghulamLine = block.split("\n").find((l) => l.includes("Ghulam"));
    const nasiraLine = block.split("\n").find((l) => l.includes("Nasira"));
    expect(ghulamLine).toContain("reason A");
    expect(ghulamLine).not.toContain("Nasira");
    expect(ghulamLine).not.toContain("reason B");
    expect(nasiraLine).toContain("reason B");
    expect(nasiraLine).not.toContain("Ghulam");
    expect(nasiraLine).not.toContain("reason A");
  });
});
