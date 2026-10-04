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

// ─────────────────────────────────────────────────────────────────────────────
// P3 Step 3 — truthful-closing rule (owner product decision, 2026-10-03)
//
// Production 2026-10-03 (conv_5901m3z8nhpjetxvm9ffcpy60bbm): the spoken
// opening was "Christopher still hasn't confirmed the car task. Everything
// else is set." while four more escalated Christopher delegations and seven
// overdue reminders were still open. Night Sweep stays concise and still
// never enumerates overdue reminders, but it must never claim an all-clear
// that authoritative state contradicts.
// ─────────────────────────────────────────────────────────────────────────────

const OCT3 = new Date("2026-10-02T21:35:00.000Z");
const ALL_CLEAR = /Everything else is set|You can close the day/;
const OVERDUE_LABELS = ["Call Loulya", "Call the doctor", "Pay bills", "Check my email", "Check my mailbox"];

function escalatedChristopher(id: string, description: string, daysAgo: number): Task {
  return makeTask({
    id,
    type: "delegation",
    description,
    assigned_to: "Christopher",
    needs_follow_up: true,
    created_at: new Date(OCT3.getTime() - daysAgo * 86_400_000).toISOString(),
    escalated_at: new Date(OCT3.getTime() - (daysAgo - 1) * 86_400_000).toISOString(),
  });
}

function overdueReminder(id: string, description: string, daysOverdue: number): Task {
  return makeTask({
    id,
    type: "reminder",
    description,
    due_at: new Date(OCT3.getTime() - daysOverdue * 86_400_000).toISOString(),
    created_at: new Date(OCT3.getTime() - (daysOverdue + 1) * 86_400_000).toISOString(),
  });
}

function oct3Shape(): Task[] {
  return [
    escalatedChristopher("d1", "bring the car around.", 18),
    escalatedChristopher("d2", "bring the car around.", 17),
    escalatedChristopher("d3", "Make a pizza for dinner.", 15),
    escalatedChristopher("d4", "call me now.", 5),
    escalatedChristopher("d5", "prepare lunch for me and track this until he confirms it.", 3),
    overdueReminder("r1", "Call Loulya", 38),
    overdueReminder("r2", "Check my mailbox", 38),
    overdueReminder("r3", "Check my email", 38),
    overdueReminder("r4", "Pay bills", 35),
    overdueReminder("r5", "Call the doctor", 35),
    overdueReminder("r6", "Call Loulya", 24),
    overdueReminder("r7", "Call Loulya", 12),
  ];
}

describe("buildNightSweepSpoken — truthful closing (P3 Step 3, 2026-10-03)", () => {
  it("reproduces the Oct 3 shape: one named escalated item never becomes 'everything else is set'", () => {
    const spoken = buildNightSweepSpoken(oct3Shape(), "Sana", OCT3, [], emptyDigest(), []);
    expect(spoken).toContain("Christopher still hasn't confirmed the car task.");
    expect(spoken).not.toMatch(ALL_CLEAR);
    expect(spoken).toContain("Other items are still open.");
  });

  it("one named escalated item + other escalated waiting items, no reminders: no false all-clear", () => {
    const tasks = oct3Shape().filter((t) => t.type === "delegation");
    const spoken = buildNightSweepSpoken(tasks, "Sana", OCT3);
    expect(spoken).not.toMatch(ALL_CLEAR);
    expect(spoken).toContain("Other items are still open.");
  });

  it("one named escalated item + overdue reminders only: no false all-clear", () => {
    const tasks = [escalatedChristopher("d1", "bring the car around.", 18), overdueReminder("r1", "Pay bills", 35)];
    const spoken = buildNightSweepSpoken(tasks, "Sana", OCT3);
    expect(spoken).toContain("Christopher still hasn't confirmed the car task.");
    expect(spoken).not.toMatch(ALL_CLEAR);
    expect(spoken).toContain("One other item is still open.");
  });

  it("overdue reminders alone (no waiting) prevent 'You can close the day'", () => {
    const tasks = [overdueReminder("r1", "Pay bills", 35), overdueReminder("r2", "Call the doctor", 35)];
    const spoken = buildNightSweepSpoken(tasks, "Sana", OCT3);
    expect(spoken).not.toMatch(ALL_CLEAR);
    expect(spoken).toBe("Good evening Sana. Some items are still open.");
  });

  it("overdue reminders are never enumerated and nothing is promoted to Needs You", () => {
    const spoken = buildNightSweepSpoken(oct3Shape(), "Sana", OCT3, [], emptyDigest(), []);
    for (const label of OVERDUE_LABELS) expect(spoken).not.toContain(label);
    expect(spoken).not.toMatch(/overdue|decision needs you|needs your review/i);
  });

  it("stays concise: at most five sentences", () => {
    const spoken = buildNightSweepSpoken(oct3Shape(), "Sana", OCT3, [], emptyDigest(), []);
    expect(spoken.split(/(?<=[.!?])\s+/).length).toBeLessThanOrEqual(5);
  });

  it("a genuine all-clear is still spoken when nothing material remains", () => {
    expect(buildNightSweepSpoken([], "Sana", OCT3)).toBe("Good evening Sana. You can close the day.");
    const onlyNamed = [escalatedChristopher("d1", "bring the car around.", 18)];
    const spoken = buildNightSweepSpoken(onlyNamed, "Sana", OCT3);
    expect(spoken).toBe("Good evening Sana. Christopher still hasn't confirmed the car task. Everything else is set.");
  });

  it("a reminder that is not overdue, or is tied to an open routine automation run, does not block the all-clear", () => {
    const future = makeTask({ id: "f1", type: "reminder", description: "Pay bills", due_at: new Date(OCT3.getTime() + 3_600_000).toISOString() });
    const routine = overdueReminder("rr", "Charge your phone", 1);
    const digest = emptyDigest({ routineAutomationTaskIds: new Set(["rr"]) });
    expect(buildNightSweepSpoken([future, routine], "Sana", OCT3, [], digest)).toBe("Good evening Sana. You can close the day.");
  });

  it("calendar behavior is unchanged: a tomorrow event still yields the 'main thing to check' close", () => {
    const tomorrow = { id: "ev1", title: "Board Review", start: new Date(OCT3.getTime() + 86_400_000).toISOString(), end: null, allDay: false } as never;
    const spoken = buildNightSweepSpoken(oct3Shape(), "Sana", OCT3, [tomorrow], emptyDigest(), []);
    expect(spoken).toContain("That is the main thing to check before tomorrow.");
    expect(spoken).not.toMatch(ALL_CLEAR);
  });

  it("a task that is both the named waiter and an overdue reminder is not counted as another open item", () => {
    const both = makeTask({
      id: "both",
      type: "reminder",
      description: "Pay bills",
      assigned_to: "Christopher",
      needs_follow_up: true,
      due_at: new Date(OCT3.getTime() - 86_400_000).toISOString(),
    });
    const spoken = buildNightSweepSpoken([both], "Sana", OCT3);
    expect(spoken).not.toMatch(/still open/);
    expect(spoken).toMatch(/Everything else is set\.$/);
  });

  it("performs no writes to its inputs", () => {
    const tasks = oct3Shape();
    const snapshot = JSON.stringify(tasks);
    for (const t of tasks) Object.freeze(t);
    Object.freeze(tasks);
    expect(() => buildNightSweepSpoken(tasks, "Sana", OCT3, [], emptyDigest(), [])).not.toThrow();
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});
