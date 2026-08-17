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
  dedupeLatestPerAutomation,
} = await import("./automation-context");

import type { AutomationDigest, AutomationRunSummary } from "./automation-context";

function makeFailedRun(overrides: Partial<AutomationRunSummary> = {}): AutomationRunSummary {
  return {
    id: "auto-failed-1",
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
      escalated: [{ id: "auto-trash", automationTitle: "Trash day", assignee: "Christopher", sentAgoMs: 0, isFollowupSent: false, escalatedAgoMs: 3_600_000 }],
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

  it("names multiple failed automations instead of a bare count", () => {
    const digest = makeDigest({ failed: [makeFailedRun(), makeFailedRun({ automationTitle: "Evening check" })] });
    const spoken = formatAutomationForMorning(digest);
    expect(spoken).toContain("daily check-in");
    expect(spoken).toContain("evening check");
    expect(spoken).not.toMatch(/^\d+ automations failed/);
  });

  it("falls through to escalated when there are no failures", () => {
    const digest = makeDigest({
      escalated: [{ id: "auto-trash", automationTitle: "Trash day", assignee: "Christopher", sentAgoMs: 0, isFollowupSent: false, escalatedAgoMs: 3_600_000 }],
    });
    expect(formatAutomationForMorning(digest)).toMatch(/escalated/i);
  });
});

describe("formatAutomationForMorning — owner reminders scheduled today", () => {
  it("names a single owner reminder before it fires", () => {
    const digest = makeDigest({
      firingToday: [{
        id: "auto-skill-check",
        title: "Daily Claude skill files check",
        assignee: null,
        nextRunAt: "2026-07-18T06:00:00.000Z",
      }],
    });

    const spoken = formatAutomationForMorning(digest);
    expect(spoken).toContain("daily Claude skill files check");
    expect(spoken).toMatch(/reminder scheduled/i);
  });

  it("summarizes multiple owner reminders and names the first", () => {
    const digest = makeDigest({
      firingToday: [
        { id: "auto-meta-template", title: "Check Meta template approval", assignee: null, nextRunAt: "2026-07-18T06:00:00.000Z" },
        { id: "auto-dentist", title: "Call the dentist", assignee: null, nextRunAt: "2026-07-18T08:00:00.000Z" },
      ],
    });

    const spoken = formatAutomationForMorning(digest);
    expect(spoken).toContain("2 reminders scheduled");
    expect(spoken).toContain("check Meta template approval");
    expect(spoken).toContain("1 more after that");
  });

  it("does not present a staff automation as the owner's personal reminder", () => {
    const digest = makeDigest({
      firingToday: [{
        id: "auto-grace-kitchen",
        title: "Grace kitchen check",
        assignee: "Grace",
        nextRunAt: "2026-07-18T06:00:00.000Z",
      }],
    });

    expect(formatAutomationForMorning(digest)).toBe("");
  });

  it("includes the owner reminder alongside a higher-priority failure", () => {
    const digest = makeDigest({
      failed: [makeFailedRun()],
      firingToday: [{
        id: "auto-dentist-2",
        title: "Call the dentist",
        assignee: null,
        nextRunAt: "2026-07-18T08:00:00.000Z",
      }],
    });

    const spoken = formatAutomationForMorning(digest);
    expect(spoken).toMatch(/failed to send/i);
    expect(spoken).toContain("call the dentist");
  });

  it("includes the owner reminder alongside a pending automation", () => {
    const digest = makeDigest({
      pending: [{ id: "auto-kitchen-check", automationTitle: "Kitchen check", assignee: "Grace", sentAgoMs: 60_000, isFollowupSent: false }],
      firingToday: [{
        id: "auto-meta-template-2",
        title: "Check Meta template approval",
        assignee: null,
        nextRunAt: "2026-07-18T08:00:00.000Z",
      }],
    });

    const spoken = formatAutomationForMorning(digest);
    expect(spoken).toMatch(/waiting for confirmation/i);
    expect(spoken).toContain("check Meta template approval");
  });
});

describe("formatAutomationForNight — failed takes priority", () => {
  it("speaks a single failed automation before escalated/pending", () => {
    const digest = makeDigest({
      failed: [makeFailedRun()],
      escalated: [{ id: "auto-trash", automationTitle: "Trash day", assignee: "Christopher", sentAgoMs: 0, isFollowupSent: false, escalatedAgoMs: 3_600_000 }],
    });
    expect(formatAutomationForNight(digest)).toMatch(/failed to send/i);
  });
});

// Production incident (2026-08-18): 4 distinct recurring automations, each
// with 2 unconfirmed automation_runs inside the 48h lookback window (a
// backlogged "yesterday" run plus today's), were counted as 8 separate
// owner-facing items — "8 automation loops are still waiting for
// confirmation tonight." Root cause: fetchAutomationDigest() never deduped
// by automation_id, so every unconfirmed run row across multiple days
// stacked as a separate item.
describe("dedupeLatestPerAutomation", () => {
  it("keeps only the first (latest) row per automation_id — 4 automations x 2 runs each does not become 8", () => {
    const rows = [
      { automation_id: "a1", sent_at: "2026-08-17T22:55:01Z" }, // latest, a1
      { automation_id: "a2", sent_at: "2026-08-17T22:36:01Z" }, // latest, a2
      { automation_id: "a3", sent_at: "2026-08-17T15:00:03Z" }, // latest, a3
      { automation_id: "a4", sent_at: "2026-08-17T12:15:01Z" }, // latest, a4
      { automation_id: "a1", sent_at: "2026-08-16T22:55:01Z" }, // stale backlog, a1
      { automation_id: "a2", sent_at: "2026-08-16T22:36:01Z" }, // stale backlog, a2
      { automation_id: "a3", sent_at: "2026-08-16T15:00:02Z" }, // stale backlog, a3
      { automation_id: "a4", sent_at: "2026-08-16T12:15:00Z" }, // stale backlog, a4
    ];
    const deduped = dedupeLatestPerAutomation(rows);
    expect(deduped).toHaveLength(4);
    expect(deduped.map((r) => r.automation_id)).toEqual(["a1", "a2", "a3", "a4"]);
  });

  it("selects the LATEST relevant run per automation, not an arbitrary one", () => {
    const rows = [
      { automation_id: "a1", sent_at: "2026-08-17T22:55:01Z", current_state: "sent" },
      { automation_id: "a1", sent_at: "2026-08-16T22:55:01Z", current_state: "sent" },
    ];
    const deduped = dedupeLatestPerAutomation(rows);
    expect(deduped).toHaveLength(1);
    expect(deduped[0].sent_at).toBe("2026-08-17T22:55:01Z");
  });

  it("does not mutate or drop rows for distinct automations — historical evidence for OTHER automations is unaffected", () => {
    const rows = [
      { automation_id: "a1", sent_at: "2026-08-17T22:55:01Z" },
      { automation_id: "a2", sent_at: "2026-08-17T22:36:01Z" },
    ];
    const deduped = dedupeLatestPerAutomation(rows);
    expect(deduped).toEqual(rows);
  });
});

describe("formatAutomationForNight — owner-facing wording for multiple open items", () => {
  const openItems = [
    { id: "a1", automationTitle: "Daily Claude skill files check", assignee: null, sentAgoMs: 0, isFollowupSent: false },
    { id: "a2", automationTitle: "Morning phone charge reminder", assignee: null, sentAgoMs: 0, isFollowupSent: false },
    { id: "a3", automationTitle: "Daily reminder test", assignee: null, sentAgoMs: 0, isFollowupSent: false },
    { id: "a4", automationTitle: "Update Rahet Bal master plan", assignee: null, sentAgoMs: 0, isFollowupSent: false },
  ];

  it("never says 'automation loops' or 'automation loop'", () => {
    const digest = makeDigest({ pending: openItems });
    const spoken = formatAutomationForNight(digest);
    expect(spoken.toLowerCase()).not.toContain("loop");
  });

  it("names the actual reminders instead of a bare count for 4 open items (the reported production case)", () => {
    const digest = makeDigest({ pending: openItems });
    const spoken = formatAutomationForNight(digest);
    expect(spoken).not.toMatch(/^\d+ automation/i);
    expect(spoken.toLowerCase()).toContain("daily claude skill files check");
    expect(spoken.toLowerCase()).toContain("morning phone charge reminder");
    expect(spoken.toLowerCase()).toContain("daily reminder test");
  });

  it("names both items for exactly 2 open items", () => {
    const digest = makeDigest({ pending: openItems.slice(0, 2) });
    const spoken = formatAutomationForNight(digest);
    expect(spoken.toLowerCase()).toContain("daily claude skill files check");
    expect(spoken.toLowerCase()).toContain("morning phone charge reminder");
    expect(spoken).toContain("and");
  });
});

describe("formatAutomationForMorning — owner-facing wording for multiple open items", () => {
  it("never says 'automation loops'", () => {
    const digest = makeDigest({
      pending: [
        { id: "a1", automationTitle: "Daily Claude skill files check", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a2", automationTitle: "Morning phone charge reminder", assignee: null, sentAgoMs: 0, isFollowupSent: false },
      ],
    });
    const spoken = formatAutomationForMorning(digest);
    expect(spoken.toLowerCase()).not.toContain("loop");
  });

  it("names multiple pending automations instead of a bare count", () => {
    const digest = makeDigest({
      pending: [
        { id: "a1", automationTitle: "Daily Claude skill files check", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a2", automationTitle: "Morning phone charge reminder", assignee: null, sentAgoMs: 0, isFollowupSent: false },
      ],
    });
    const spoken = formatAutomationForMorning(digest);
    expect(spoken).not.toMatch(/^\d+ automations are waiting/);
    expect(spoken.toLowerCase()).toContain("daily claude skill files check");
    expect(spoken.toLowerCase()).toContain("morning phone charge reminder");
  });
});
