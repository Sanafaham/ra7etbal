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
});
