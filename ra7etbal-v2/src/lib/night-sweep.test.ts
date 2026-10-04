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

// P3 Step 3 (S1) — Night Sweep waiting-state truth. Real Production evidence
// (owner session conv_5901m3z8nhpjetxvm9ffcpy60bbm, 2026-10-02): five
// escalated, unconfirmed Christopher delegations plus seven overdue reminders,
// yet the opening said "Christopher still hasn't confirmed the car task.
// Everything else is set." The named item is only a representative; the brief
// must state that more material waiting work exists and must not close with
// an all-clear. Overdue reminders stay outside Night Sweep (existing contract).
describe("buildNightSweepSpoken — material waiting count truth (P3 Step 3, S1)", () => {
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 60 * 60 * 1000).toISOString();
  const escalatedDelegation = (id: string, description: string, createdHoursAgo: number, assignee = "Christopher") =>
    makeTask({
      id,
      type: "delegation",
      assigned_to: assignee,
      status: "pending",
      description,
      created_at: hoursAgo(createdHoursAgo),
      escalated_at: hoursAgo(createdHoursAgo - 1),
    });
  const overdueReminder = (id: string, description: string, dueHoursAgo: number) =>
    makeTask({
      id,
      type: "reminder",
      status: "pending",
      description,
      created_at: hoursAgo(dueHoursAgo + 1),
      due_at: hoursAgo(dueHoursAgo),
    });

  // Shape of the real 2026-10-02 Production state (oldest first).
  const productionDelegations = [
    escalatedDelegation("d1", "bring the car around.", 18 * 24),
    escalatedDelegation("d2", "bring the car around.", 17 * 24),
    escalatedDelegation("d3", "Make a pizza for dinner.", 15 * 24),
    escalatedDelegation("d4", "call me now.", 5 * 24),
    escalatedDelegation("d5", "prepare lunch for me and track this until he confirms it.", 3 * 24),
  ];
  const productionOverdueReminders = [
    overdueReminder("r1", "Call Loulya", 38 * 24),
    overdueReminder("r2", "Check my mailbox", 38 * 24),
    overdueReminder("r3", "Check my email", 38 * 24),
    overdueReminder("r4", "Pay bills", 36 * 24),
    overdueReminder("r5", "Call the doctor", 36 * 24),
    overdueReminder("r6", "Call Loulya", 24 * 24),
    overdueReminder("r7", "Call Loulya", 12 * 24),
  ];

  it("A. zero material waiting items — unchanged close", () => {
    expect(buildNightSweepSpoken([], "Sana", NOW)).toBe("Good evening Sana. You can close the day.");
    const routine = makeTask({ type: "delegation", assigned_to: "Grace", status: "pending", created_at: hoursAgo(1) });
    const spoken = buildNightSweepSpoken([routine], "Sana", NOW);
    expect(spoken).toBe("Good evening Sana. Everything else is set.");
    expect(spoken).not.toMatch(/more waiting/);
  });

  it("B. exactly one material waiting item — unchanged wording", () => {
    const spoken = buildNightSweepSpoken([escalatedDelegation("d1", "bring the car around.", 48)], "Sana", NOW);
    expect(spoken).toBe("Good evening Sana. Christopher still hasn't confirmed the car task. Everything else is set.");
  });

  it("C. multiple material waiting items — states the others and never closes with an all-clear", () => {
    const tasks = [
      escalatedDelegation("d1", "bring the car around.", 48),
      escalatedDelegation("d2", "Make a pizza for dinner.", 24, "Grace"),
    ];
    const spoken = buildNightSweepSpoken(tasks, "Sana", NOW);
    expect(spoken).toBe(
      "Good evening Sana. Christopher still hasn't confirmed the car task, and one more waiting item is still open.",
    );
    expect(spoken).not.toContain("Everything else is set.");
  });

  it("C2. non-material (fresh, routine) waiting items are not counted", () => {
    const tasks = [
      escalatedDelegation("d1", "bring the car around.", 48),
      makeTask({ id: "fresh", type: "delegation", assigned_to: "Grace", status: "pending", created_at: hoursAgo(1) }),
    ];
    expect(buildNightSweepSpoken(tasks, "Sana", NOW)).toBe(
      "Good evening Sana. Christopher still hasn't confirmed the car task. Everything else is set.",
    );
  });

  it("D. real Production shape — five escalated Christopher delegations", () => {
    const spoken = buildNightSweepSpoken(productionDelegations, "Sana", NOW);
    expect(spoken).toBe(
      "Good evening Sana. Christopher still hasn't confirmed the car task, and four more waiting items are still open.",
    );
  });

  it("E. overdue reminders do not change Night Sweep output (existing reminder contract untouched)", () => {
    const shapes: Task[][] = [[], [escalatedDelegation("d1", "bring the car around.", 48)], productionDelegations];
    for (const shape of shapes) {
      const without = buildNightSweepSpoken(shape, "Sana", NOW);
      const withReminders = buildNightSweepSpoken([...shape, ...productionOverdueReminders], "Sana", NOW);
      expect(withReminders).toBe(without);
      expect(withReminders).not.toMatch(/reminder|overdue|missed|unseen|ignored|completed/i);
    }
  });

  it("F. no false all-clear when more material waiting items exist — with tomorrow events and with Needs You", () => {
    const tomorrow = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + 1, 10, 0, 0);
    const events = [{ id: "ev1", title: "Dentist", start: tomorrow.toISOString(), end: null, location: null, allDay: false }];
    const withEvents = buildNightSweepSpoken(productionDelegations, "Sana", NOW, events);
    expect(withEvents).toContain("and four more waiting items are still open.");
    expect(withEvents).not.toContain("Everything else is set.");

    const withNeedsYou = buildNightSweepSpoken(productionDelegations, "Sana", NOW, [], undefined, [
      { id: "esc-1", staffName: "Grace", inboundText: "done?", escalationReason: null, receivedAt: NOW.toISOString(), taskId: null, decisionId: "dec-1", deepLinkToken: "tok" },
    ]);
    expect(withNeedsYou).toContain("and four more waiting items are still open.");
    expect(withNeedsYou).not.toContain("Everything else is set.");
  });

  it("waiting work is never described as completed or handled", () => {
    const spoken = buildNightSweepSpoken(productionDelegations, "Sana", NOW);
    expect(spoken).not.toMatch(/\b(handled|done|completed|finished)\b/i);
    expect(spoken).not.toMatch(/(?<!hasn't )confirmed the/i);
  });
});
