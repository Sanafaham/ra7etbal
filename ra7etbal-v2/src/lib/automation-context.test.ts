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
  isOperationalAutomationRunRow,
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

describe("automation operational-state filtering", () => {
  it("excludes unsupported recurring WhatsApp runs before Carson state is built", () => {
    expect(isOperationalAutomationRunRow({
      automations: {
        title: "Weekly Flower Inventory",
        automation_type: "delegation",
        assignee_id: "grace-id",
        cadence_type: "weekly",
      },
    })).toBe(false);
    expect(isOperationalAutomationRunRow({
      automations: {
        title: "Daily message",
        automation_type: "message",
        assignee_id: "grace-id",
        cadence_type: "daily",
      },
    })).toBe(false);
  });

  it("keeps supported owner-only and one-time runs in Carson state", () => {
    expect(isOperationalAutomationRunRow({
      automations: {
        title: "Weekly owner reminder",
        automation_type: "delegation",
        assignee_id: null,
        cadence_type: "weekly",
      },
    })).toBe(true);
    expect(isOperationalAutomationRunRow({
      automations: {
        title: "One-time Grace task",
        automation_type: "delegation",
        assignee_id: "grace-id",
        cadence_type: "once",
      },
    })).toBe(true);
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

describe("formatAutomationForMorning — owner reminders scheduled today", () => {
  it("names a single owner reminder before it fires", () => {
    const digest = makeDigest({
      firingToday: [{
        title: "Daily Claude skill files check",
        assignee: null,
        nextRunAt: "2026-07-18T06:00:00.000Z",
      }],
    });

    const spoken = formatAutomationForMorning(digest);
    expect(spoken).toContain("Daily Claude skill files check".toLowerCase());
    expect(spoken).toMatch(/reminder scheduled/i);
  });

  it("summarizes multiple owner reminders and names the first", () => {
    const digest = makeDigest({
      firingToday: [
        { title: "Check Meta template approval", assignee: null, nextRunAt: "2026-07-18T06:00:00.000Z" },
        { title: "Call the dentist", assignee: null, nextRunAt: "2026-07-18T08:00:00.000Z" },
      ],
    });

    const spoken = formatAutomationForMorning(digest);
    expect(spoken).toContain("2 reminders scheduled");
    expect(spoken).toContain("check Meta template approval".toLowerCase());
    expect(spoken).toContain("1 more after that");
  });

  it("does not present a staff automation as the owner's personal reminder", () => {
    const digest = makeDigest({
      firingToday: [{
        title: "Grace kitchen check",
        assignee: "Grace",
        nextRunAt: "2026-07-18T06:00:00.000Z",
      }],
    });

    expect(formatAutomationForMorning(digest)).toBe("");
  });

  it("keeps failure priority above a scheduled owner reminder", () => {
    const digest = makeDigest({
      failed: [makeFailedRun()],
      firingToday: [{
        title: "Call the dentist",
        assignee: null,
        nextRunAt: "2026-07-18T08:00:00.000Z",
      }],
    });

    expect(formatAutomationForMorning(digest)).toMatch(/failed to send/i);
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
