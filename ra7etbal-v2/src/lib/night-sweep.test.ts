import { describe, expect, it, vi } from "vitest";

// night-sweep.ts -> morning-brief.ts -> calendar.ts / automation-context.ts
// import ./supabase at module top level, which throws without
// VITE_SUPABASE_* env vars. Stub it the same way automation-context.test.ts
// / carson-material-items.test.ts / morning-brief.test.ts do.
vi.mock("./supabase", () => ({ supabase: {} }));

const { buildNightSweepSpoken } = await import("./night-sweep");

import type { Task } from "../types/task";
import type { AutomationDigest } from "./automation-context";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "Buy milk",
    type: "reminder",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-08-17T10:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    worker_reply: null,
    ...overrides,
  };
}

function emptyDigest(overrides: Partial<AutomationDigest> = {}): AutomationDigest {
  return { pending: [], escalated: [], failed: [], confirmedToday: [], firingToday: [], firingTomorrow: [], routineAutomationTaskIds: new Set(), ...overrides };
}

const NOW = new Date("2026-08-18T21:00:00.000Z");

describe("buildNightSweepSpoken — canonical task labeling (shared with Morning Brief)", () => {
  // Production incident (2026-08-18): "Clean the kitchen." was spoken as
  // "Christopher confirmed food task" in Night Sweep because a duplicated,
  // independently-drifting copy of the label patterns (NS_LABEL_PATTERNS)
  // still contained the "kitchen" keyword after it was removed from
  // morning-brief.ts. Night Sweep now imports the single canonical
  // taskLabel()/buildCompletionPhrase() from morning-brief.ts.
  it("'Clean the kitchen.' never becomes 'food task' — natural outcome language instead", () => {
    const task = makeTask({
      description: "Clean the kitchen.",
      type: "delegation",
      assigned_to: "Christopher",
      status: "done",
      confirmed_at: "2026-08-18T20:00:00.000Z",
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW);
    expect(spoken).not.toContain("food task");
    expect(spoken).toContain("Christopher finished cleaning the kitchen.");
  });

  it("real grocery/food completions remain correctly categorized", () => {
    const task = makeTask({
      description: "Buy groceries for the week",
      type: "delegation",
      assigned_to: "Christopher",
      status: "done",
      confirmed_at: "2026-08-18T20:00:00.000Z",
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW);
    expect(spoken).toContain("confirmed the food task");
  });
});

describe("buildNightSweepSpoken — routine waiting items are excluded (Chief-of-Staff contract)", () => {
  it("a fresh, non-escalated waiting item is not spoken merely because it exists", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(), // 1h ago
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW);
    expect(spoken).not.toMatch(/waiting|confirm/i);
    expect(spoken).toContain("Everything else is set.");
  });

  it("an escalated waiting item is spoken", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      escalated_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW);
    expect(spoken).toContain("Grace still hasn't confirmed");
  });

  // Chief-of-Staff contract (2026-08-18, second pass): age alone is never
  // sufficient relevance — a routine delegation that has simply sat for a
  // while, with no escalation, deadline, or owner-decision signal, is not
  // spoken merely because time passed. (This replaces an earlier version
  // of this contract that used a 3-day-age gate as a stand-in for
  // importance — explicitly rejected as still age-based, not
  // consequence-based.)
  it("a waiting item stale for many days with no other signal is NOT spoken", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW);
    expect(spoken).not.toMatch(/Grace/);
    expect(spoken).toContain("Everything else is set.");
  });

  it("a waiting item that is overdue (due_at in the past) is spoken, regardless of age", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      due_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW);
    expect(spoken).toContain("Grace needs to confirm");
  });

  it("a waiting item flagged for owner review (quality_review_status) is spoken", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      quality_review_status: "uncertain",
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW);
    expect(spoken).toContain("needs your review");
  });
});

describe("buildNightSweepSpoken — quiet night", () => {
  it("nothing important remaining is stated plainly, not filled with low-value information", () => {
    const spoken = buildNightSweepSpoken([], "Sana", NOW);
    expect(spoken).toBe("Good evening Sana. You can close the day.");
  });
});

describe("buildNightSweepSpoken — routine automation status is excluded entirely", () => {
  it("4 routine pending automations produce no automation sentence", () => {
    const digest = emptyDigest({
      pending: [
        { id: "a1", automationTitle: "Daily Claude skill files check", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a2", automationTitle: "Morning phone charge reminder", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a3", automationTitle: "Daily reminder test", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a4", automationTitle: "Update Rahet Bal master plan", assignee: null, sentAgoMs: 0, isFollowupSent: false },
      ],
    });
    const spoken = buildNightSweepSpoken([], "Sana", NOW, [], digest);
    expect(spoken).not.toMatch(/waiting for confirmation|automation/i);
    expect(spoken).toBe("Good evening Sana. You can close the day.");
  });

  it("a failed automation is still spoken", () => {
    const digest = emptyDigest({
      failed: [{ id: "a1", automationTitle: "Daily reminder test", assignee: null, sentAgoMs: 0, isFollowupSent: false, failureReason: "delivery error" }],
    });
    const spoken = buildNightSweepSpoken([], "Sana", NOW, [], digest);
    expect(spoken).toMatch(/failed to send/i);
  });
});

describe("buildNightSweepSpoken — Needs You (distinct from Waiting On Others)", () => {
  it("a genuine owner decision surfaces and is not phrased as 'waiting on others'", () => {
    const spoken = buildNightSweepSpoken([], "Sana", NOW, [], undefined, [
      { id: "esc-1", staffName: "Christopher", inboundText: "done?", escalationReason: null, receivedAt: NOW.toISOString(), taskId: null, decisionId: "dec-1", deepLinkToken: "tok" },
    ]);
    expect(spoken).toContain("One decision needs you — Christopher is waiting on an answer.");
    expect(spoken).not.toMatch(/waiting on others/i);
  });

  it("Needs You is never silently dropped for space, even with a full brief", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      escalated_at: NOW.toISOString(),
    });
    const spoken = buildNightSweepSpoken([task], "Sana", NOW, [], undefined, [
      { id: "esc-1", staffName: "Christopher", inboundText: "done?", escalationReason: null, receivedAt: NOW.toISOString(), taskId: null, decisionId: "dec-1", deepLinkToken: "tok" },
    ]);
    expect(spoken).toContain("One decision needs you");
  });
});

describe("buildNightSweepSpoken — post-midnight continuation (PR #308 protection)", () => {
  it("greeting remains 'Good evening' at 1:58 AM (briefKind consolidation happens upstream in carson-opening.ts)", () => {
    const lateNight = new Date("2026-08-18T01:58:00");
    const spoken = buildNightSweepSpoken([], "Sana", lateNight);
    expect(spoken).toContain("Good evening Sana.");
    expect(spoken).not.toContain("Good morning");
  });
});
