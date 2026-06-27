import { describe, it, expect } from "vitest";

// automation-context.ts imports ./supabase at module top level, which throws
// without VITE_SUPABASE_* env vars. We only test the pure formatters here
// (buildAutomationStatusBlock / formatAutomationForMorning / formatAutomationForNight),
// so stub the client the same way carson-context.test.ts does.
import { vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: {} }));

const {
  buildAutomationStatusBlock,
  formatAutomationForMorning,
  formatAutomationForNight,
} = await import("./automation-context");

import type { AutomationDigest, AutomationRunSummary } from "./automation-context";

function makeFailedRun(overrides: Partial<AutomationRunSummary> = {}): AutomationRunSummary {
  return {
    automationTitle: "Daily check-in",
    assignee: "Sana",
    sentAgoMs: 2 * 3_600_000,
    isFollowupSent: false,
    failureReason: "In order to maintain a healthy ecosystem engagement, the message failed to be delivered.",
    ...overrides,
  };
}

function makeDigest(overrides: Partial<AutomationDigest> = {}): AutomationDigest {
  return {
    pending: [],
    escalated: [],
    failed: [],
    confirmedToday: [],
    firingToday: [],
    firingTomorrow: [],
    ...overrides,
  };
}

describe("buildAutomationStatusBlock — Phase 9A failed-run visibility", () => {
  it("renders a Failed section with the failure reason when a run has failed", () => {
    const digest = makeDigest({ failed: [makeFailedRun()] });
    const block = buildAutomationStatusBlock(digest);
    expect(block).toContain("Failed (delivery or send failure");
    expect(block).toContain("Daily check-in");
    expect(block).toContain("Sana");
    expect(block).toContain("ecosystem engagement");
  });

  it("omits the Failed section entirely when there are no failed runs", () => {
    const digest = makeDigest();
    const block = buildAutomationStatusBlock(digest);
    expect(block).not.toContain("Failed (delivery or send failure");
    expect(block).toContain("No active automation issues.");
  });

  it("still renders pending/escalated sections alongside a failed section", () => {
    const digest = makeDigest({
      failed: [makeFailedRun()],
      escalated: [{ automationTitle: "Trash day", assignee: "Christopher", sentAgoMs: 0, isFollowupSent: false, escalatedAgoMs: 3_600_000 }],
    });
    const block = buildAutomationStatusBlock(digest);
    expect(block).toContain("Escalated:");
    expect(block).toContain("Failed (delivery or send failure");
  });
});

describe("formatAutomationForMorning — failed takes priority over escalated/pending", () => {
  it("speaks a single failed automation", () => {
    const digest = makeDigest({ failed: [makeFailedRun()] });
    expect(formatAutomationForMorning(digest)).toMatch(/failed to send/i);
  });

  it("speaks multiple failed automations as a count", () => {
    const digest = makeDigest({ failed: [makeFailedRun(), makeFailedRun({ automationTitle: "Evening check" })] });
    expect(formatAutomationForMorning(digest)).toContain("2 automations failed to send");
  });

  it("falls through to escalated when there are no failures", () => {
    const digest = makeDigest({
      escalated: [{ automationTitle: "Trash day", assignee: "Christopher", sentAgoMs: 0, isFollowupSent: false, escalatedAgoMs: 3_600_000 }],
    });
    expect(formatAutomationForMorning(digest)).toMatch(/escalated/i);
  });
});

describe("formatAutomationForNight — failed takes priority", () => {
  it("speaks a single failed automation before escalated/pending", () => {
    const digest = makeDigest({
      failed: [makeFailedRun()],
      escalated: [{ automationTitle: "Trash day", assignee: "Christopher", sentAgoMs: 0, isFollowupSent: false, escalatedAgoMs: 3_600_000 }],
    });
    expect(formatAutomationForNight(digest)).toMatch(/failed to send/i);
  });
});
