/**
 * P3 5b — every operational surface shares one definition of CURRENT.
 *
 * The unit rules live in carson-recurring-manifestations.test.ts. This file
 * pins the consumer boundaries: that each surface which reasons about current
 * operational state actually receives the corrected membership, that the
 * bounded OPEN 15 stops being consumed by stale recurring history, and that
 * history, completions, ordering and window size are untouched.
 */

import { describe, it, expect, vi } from "vitest";

// carson-context.ts / morning-brief.ts / night-sweep.ts reach ./supabase at
// module top level via calendar.ts and automation-context.ts, which throws
// without VITE_SUPABASE_* env vars. Stub it exactly as morning-brief.test.ts
// and automation-context.test.ts do — every function exercised here is pure and
// no real Supabase client is ever used.
vi.mock("./supabase", () => ({ supabase: {} }));

const { buildCarsonContext } = await import("./carson-context");
const { buildMorningBriefSpoken } = await import("./morning-brief");
const { buildNightSweepSpoken } = await import("./night-sweep");
import { composeAttentionEvidence } from "../../shared/carson-attention-summary.js";
import {
  indexAutomationSourceLinks,
  indexNotificationAutomationClaims,
  indexRoutineSourceLinks,
} from "../../shared/carson-recurring-manifestations.js";
import type { AutomationDigest } from "./automation-context";
import type { Task } from "../types/task";

const OWNER = "645ddb96-6e09-4d91-b650-cbc75bac9a5d";
const AUTOMATION = "2b0153f2-b779-40b8-bd62-f06d5cbb07d5";
const ROUTINE = "39869df9-a024-4d70-b3d9-642714bb4492";

/** 2026-09-26, the snapshot the Production evidence was taken from. */
const NOW = new Date("2026-09-26T09:00:00.000Z");

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "t-1",
    user_id: OWNER,
    description: "Buy milk",
    type: "reminder",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    dismissed_at: null,
    archived_at: null,
    created_at: "2026-09-01T10:00:00.000Z",
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
  } as Task;
}

function digest(overrides: Partial<AutomationDigest> = {}): AutomationDigest {
  return {
    pending: [],
    escalated: [],
    failed: [],
    confirmedToday: [],
    firingToday: [],
    firingTomorrow: [],
    routineAutomationTaskIds: new Set(),
    ...overrides,
  };
}

/**
 * The measured 2026-09-26 Production shape, scaled down but structurally
 * identical: one automation source and one routine source with a long
 * unresolved daily tail, plus genuine owner responsibilities that are older
 * than the whole tail and therefore last in newest-first order.
 */
function productionShape(tailLength = 20) {
  const tasks: Task[] = [];
  const runs: Array<{ task_id: string; automation_id: string; user_id: string }> = [];
  const notifications: Array<Record<string, unknown>> = [];

  for (let i = 0; i < tailLength; i++) {
    const day = String(26 - i).padStart(2, "0");

    const autoId = `auto-${i}`;
    tasks.push(
      task({
        id: autoId,
        type: "action",
        description: "Update the Rahet Bal master plan.",
        created_at: `2026-09-${day}T12:15:02.000Z`,
      }),
    );
    runs.push({ task_id: autoId, automation_id: AUTOMATION, user_id: OWNER });

    const routineId = `routine-${i}`;
    tasks.push(
      task({
        id: routineId,
        type: "action",
        description: "Test routine reminder",
        created_at: `2026-09-${day}T11:10:01.000Z`,
      }),
    );
    notifications.push({
      target_id: routineId,
      kind: "routine_reminder",
      user_id: OWNER,
      metadata: { routine_id: ROUTINE },
    });
  }

  // Genuine responsibilities, all older than the recurring tail.
  const genuine: Task[] = [
    task({
      id: "genuine-overdue-reminder",
      type: "reminder",
      description: "Call the doctor",
      due_at: "2026-08-28T09:00:00.000Z",
      created_at: "2026-08-27T20:13:17.000Z",
    }),
    task({
      id: "genuine-escalated-delegation",
      type: "delegation",
      description: "bring the car around.",
      assigned_to: "Christopher",
      needs_follow_up: true,
      escalated_at: "2026-09-14T00:39:57.000Z",
      created_at: "2026-08-27T19:56:00.000Z",
    }),
    task({
      id: "genuine-mailbox",
      type: "reminder",
      description: "Check my mailbox",
      due_at: "2026-08-26T09:00:00.000Z",
      created_at: "2026-08-25T14:50:07.000Z",
    }),
  ];
  tasks.push(...genuine);

  // The real read order from listTasks(): created_at DESC.
  tasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const recurringSourceIndexes = {
    automationLinks: indexAutomationSourceLinks(runs),
    routineLinks: indexRoutineSourceLinks(notifications as never),
    notificationAutomationClaims: indexNotificationAutomationClaims(notifications as never),
  };

  return {
    tasks,
    genuineIds: genuine.map((g) => g.id),
    digest: digest({ recurringSourceIndexes }),
    recurringSourceIndexes,
  };
}

function openBlockLines(context: string): string[] {
  const lines = context.split("\n");
  const start = lines.findIndex((l) => l === "OPEN:");
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("- ") && !line.startsWith("(showing ")) break;
    if (line.startsWith("- ")) out.push(line);
  }
  return out;
}

describe("carson-context OPEN — the bounded 15 displacement site", () => {
  it("reproduces the defect: without the correction stale recurring history fills the window", () => {
    const { tasks, genuineIds } = productionShape();

    // No recurringSourceIndexes — the pre-correction behavior.
    const context = buildCarsonContext({ tasks, people: [], now: NOW });
    const open = openBlockLines(context);

    expect(open).toHaveLength(15);
    for (const id of genuineIds) {
      expect(context).not.toContain(id);
    }
    expect(open.every((l) => l.includes("master plan") || l.includes("Test routine reminder"))).toBe(true);
  });

  it("after the correction the window holds one manifestation per source plus the genuine work", () => {
    const { tasks, genuineIds, recurringSourceIndexes } = productionShape();

    const context = buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes });
    const open = openBlockLines(context);

    // 2 current recurring + 3 genuine — nothing truncated, no "(showing 15 of N)".
    expect(open).toHaveLength(5);
    expect(context).not.toContain("(showing 15 of");

    expect(open.filter((l) => l.includes("master plan"))).toHaveLength(1);
    expect(open.filter((l) => l.includes("Test routine reminder"))).toHaveLength(1);
    for (const description of ["Call the doctor", "bring the car around.", "Check my mailbox"]) {
      expect(context).toContain(description);
    }
    expect(genuineIds.length).toBe(3);
  });

  it("keeps the newest manifestation, not an arbitrary one", () => {
    const { tasks, recurringSourceIndexes } = productionShape();

    const context = buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes });

    // auto-0 / routine-0 are the 2026-09-26 firings — the newest of each source.
    const open = openBlockLines(context);
    const masterPlanLines = open.filter((l) => l.includes("master plan"));
    const routineLines = open.filter((l) => l.includes("Test routine reminder"));

    expect(masterPlanLines).toHaveLength(1);
    expect(routineLines).toHaveLength(1);
    expect(masterPlanLines[0]).toContain("Sep 26");
    expect(routineLines[0]).toContain("Sep 26");
    // Not an older firing.
    expect(masterPlanLines[0]).not.toContain("Sep 25");
  });

  it("preserves created_at DESC ordering and the 15-row window", () => {
    // 20 genuine reminders, no recurring history at all: the window must still
    // cap at 15 and still be newest-first.
    const tasks = Array.from({ length: 20 }, (_, i) =>
      task({
        id: `g-${i}`,
        description: `Genuine ${i}`,
        created_at: `2026-09-${String(20 - i).padStart(2, "0")}T10:00:00.000Z`,
      }),
    );

    const context = buildCarsonContext({
      tasks,
      people: [],
      now: NOW,
      recurringSourceIndexes: {
        automationLinks: new Map(),
        routineLinks: new Map(),
        notificationAutomationClaims: new Map(),
      },
    });
    const open = openBlockLines(context);

    expect(open).toHaveLength(15);
    expect(context).toContain("(showing 15 of 20 open items)");
    expect(open[0]).toContain("Genuine 0");
    expect(open[14]).toContain("Genuine 14");
  });

  it("does not alter the COMPLETED history block", () => {
    const { tasks, recurringSourceIndexes } = productionShape(4);
    const withCompletion = [
      ...tasks,
      task({
        id: "done-1",
        type: "delegation",
        description: "Make a pizza for dinner.",
        assigned_to: "Christopher",
        status: "done",
        confirmed_at: "2026-09-25T18:00:00.000Z",
        created_at: "2026-09-25T15:00:00.000Z",
      }),
    ];

    const before = buildCarsonContext({ tasks: withCompletion, people: [], now: NOW });
    const after = buildCarsonContext({
      tasks: withCompletion,
      people: [],
      now: NOW,
      recurringSourceIndexes,
    });

    const completedOf = (ctx: string) => ctx.slice(ctx.indexOf("COMPLETED (recent"));
    expect(completedOf(after)).toBe(completedOf(before));
    expect(after).toContain("1 completed by Christopher");
  });
});

describe("Morning Brief receives the shared current membership", () => {
  it("does not let stale recurring history crowd the spoken brief", () => {
    const { tasks, digest: d } = productionShape();

    const corrected = buildMorningBriefSpoken(tasks, [], "Sana", NOW, [], d, []);
    const uncorrected = buildMorningBriefSpoken(tasks, [], "Sana", NOW, [], digest(), []);

    // The genuine overdue reminder is what the owner needs to hear.
    expect(corrected).toContain("doctor");
    // Membership narrowing can only remove recurring manifestations, so the
    // corrected brief never mentions more of them than the uncorrected one.
    const countMasterPlan = (s: string) => s.split("master plan").length - 1;
    expect(countMasterPlan(corrected)).toBeLessThanOrEqual(countMasterPlan(uncorrected));
  });

  it("is unchanged when there is no recurring history", () => {
    const tasks = [
      task({ id: "r1", description: "Call the doctor", due_at: "2026-09-25T09:00:00.000Z" }),
      task({
        id: "d1",
        type: "delegation",
        description: "bring the car around.",
        assigned_to: "Christopher",
        needs_follow_up: true,
        escalated_at: "2026-09-25T10:00:00.000Z",
      }),
    ];

    const withIndexes = buildMorningBriefSpoken(
      tasks,
      [],
      "Sana",
      NOW,
      [],
      digest({
        recurringSourceIndexes: {
          automationLinks: new Map(),
          routineLinks: new Map(),
          notificationAutomationClaims: new Map(),
        },
      }),
      [],
    );
    const withoutIndexes = buildMorningBriefSpoken(tasks, [], "Sana", NOW, [], digest(), []);

    expect(withIndexes).toBe(withoutIndexes);
  });
});

describe("Night Sweep receives the shared current membership", () => {
  it("is unchanged when there is no recurring history", () => {
    const tasks = [
      task({
        id: "d1",
        type: "delegation",
        description: "bring the car around.",
        assigned_to: "Christopher",
        needs_follow_up: true,
        escalated_at: "2026-09-25T10:00:00.000Z",
      }),
    ];
    const evening = new Date("2026-09-26T21:00:00.000Z");

    const withIndexes = buildNightSweepSpoken(
      tasks,
      "Sana",
      evening,
      [],
      digest({
        recurringSourceIndexes: {
          automationLinks: new Map(),
          routineLinks: new Map(),
          notificationAutomationClaims: new Map(),
        },
      }),
      [],
    );
    const withoutIndexes = buildNightSweepSpoken(tasks, "Sana", evening, [], digest(), []);

    expect(withIndexes).toBe(withoutIndexes);
  });

  it("reasons about one current recurring manifestation, not the whole tail", () => {
    const { tasks, digest: d } = productionShape();
    const evening = new Date("2026-09-26T21:00:00.000Z");

    const corrected = buildNightSweepSpoken(tasks, "Sana", evening, [], d, []);
    const uncorrected = buildNightSweepSpoken(tasks, "Sana", evening, [], digest(), []);

    const countMasterPlan = (s: string) => s.split("master plan").length - 1;
    expect(countMasterPlan(corrected)).toBeLessThanOrEqual(countMasterPlan(uncorrected));
    expect(corrected.length).toBeGreaterThan(0);
  });
});

describe("attention evidence receives the same current membership", () => {
  function compose(tasks: Task[], recurringSourceIndexes?: unknown) {
    return composeAttentionEvidence({
      generatedAt: NOW.toISOString(),
      now: NOW,
      tasks,
      tasksFailed: false,
      needsYou: [],
      needsYouFailed: false,
      captureCandidates: [],
      capturesFailed: false,
      routineAutomationTaskIds: new Set(),
      recurringSourceIndexes,
    } as never);
  }

  it("drops superseded recurring manifestations from every bucket", () => {
    const { tasks, recurringSourceIndexes } = productionShape();

    const before = compose(tasks);
    const after = compose(tasks, recurringSourceIndexes);

    const allIds = (e: Record<string, Array<{ id: string }>>) =>
      [
        ...e.needsYou,
        ...e.overdueReminders,
        ...e.upcomingReminders,
        ...e.waiting,
        ...e.later,
      ].map((i) => i.id);

    const beforeIds = allIds(before as never);
    const afterIds = allIds(after as never);

    // Many stale manifestations before; at most the single CURRENT one after.
    expect(beforeIds.filter((id) => id.startsWith("auto-")).length).toBeGreaterThan(1);
    expect(beforeIds.filter((id) => id.startsWith("routine-")).length).toBeGreaterThan(1);
    for (const prefix of ["auto-", "routine-"]) {
      const remaining = afterIds.filter((id) => id.startsWith(prefix));
      expect(remaining.length).toBeLessThanOrEqual(1);
      // Whatever survives must be the newest firing, never an older one.
      for (const id of remaining) expect(id).toBe(`${prefix}0`);
    }
    // Genuine work survives.
    expect(afterIds).toContain("genuine-escalated-delegation");
    // Nothing new appeared.
    for (const id of afterIds) expect(beforeIds).toContain(id);
  });

  it("is unchanged when no indexes are supplied", () => {
    const tasks = [
      task({
        id: "d1",
        type: "delegation",
        description: "bring the car around.",
        assigned_to: "Christopher",
        needs_follow_up: true,
        escalated_at: "2026-09-25T10:00:00.000Z",
      }),
    ];

    expect(JSON.stringify(compose(tasks))).toBe(
      JSON.stringify(
        compose(tasks, {
          automationLinks: new Map(),
          routineLinks: new Map(),
          notificationAutomationClaims: new Map(),
        }),
      ),
    );
  });

  it("does not mutate the caller's task array", () => {
    const { tasks, recurringSourceIndexes } = productionShape(5);
    const before = tasks.length;
    const snapshot = tasks.map((t) => t.id).join(",");

    compose(tasks, recurringSourceIndexes);

    expect(tasks).toHaveLength(before);
    expect(tasks.map((t) => t.id).join(",")).toBe(snapshot);
  });
});

describe("failed-run manifestation at the consumer boundary", () => {
  it("supersedes the 2026-09-13 orphan without touching its task fields", () => {
    const orphan = task({
      id: "446f2210-3be2-40b7-ae1c-16a8c1579dd4",
      type: "action",
      description: "Update the Rahet Bal master plan.",
      created_at: "2026-09-13T12:15:09.643962Z",
    });
    const newest = task({
      id: "newest",
      type: "action",
      description: "Update the Rahet Bal master plan.",
      created_at: "2026-09-26T12:15:01.984962Z",
    });
    const recurringSourceIndexes = {
      automationLinks: indexAutomationSourceLinks([
        // The failed run still carries the source identity.
        { task_id: orphan.id, automation_id: AUTOMATION, user_id: OWNER },
        { task_id: newest.id, automation_id: AUTOMATION, user_id: OWNER },
      ]),
      routineLinks: new Map(),
      notificationAutomationClaims: new Map(),
    };

    const context = buildCarsonContext({
      tasks: [newest, orphan],
      people: [],
      now: NOW,
      recurringSourceIndexes,
    });
    const open = openBlockLines(context);

    expect(open).toHaveLength(1);
    expect(open[0]).toContain("Sep 26");
    // The orphan row itself is untouched — still pending, never completed.
    expect(orphan.status).toBe("pending");
    expect(orphan.confirmed_at).toBeNull();
    expect(orphan.archived_at).toBeNull();
    expect(orphan.dismissed_at).toBeNull();
  });
});
