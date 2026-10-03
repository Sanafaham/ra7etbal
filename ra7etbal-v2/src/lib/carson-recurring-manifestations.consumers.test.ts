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
const { deriveNightSweepMaterialItems, deriveMorningBriefMaterialItems } = await import("./carson-material-items");
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

describe("attention completeness is truthful about missing link evidence", () => {
  function compose(extra: Record<string, unknown>) {
    return composeAttentionEvidence({
      generatedAt: NOW.toISOString(),
      now: NOW,
      tasks: [task({ id: "t1" })],
      tasksFailed: false,
      needsYou: [],
      needsYouFailed: false,
      captureCandidates: [],
      capturesFailed: false,
      routineAutomationTaskIds: new Set(),
      ...extra,
    } as never) as unknown as { completeness: string; code: string };
  }

  it("reports partial when the recurring-source read failed", () => {
    const failed = compose({ recurringSourceFailed: true });

    expect(failed.completeness).toBe("partial");
    expect(failed.code).toBe("attention_read_partial");
  });

  it("reports full for a loaded digest whose owner simply has no recurring history", () => {
    // The distinction CI caught: "loaded, nothing in it" must NOT be reported as
    // partial. Empty indexes with a successful load are complete evidence.
    const loadedButEmpty = compose({
      recurringSourceFailed: false,
      recurringSourceIndexes: {
        automationLinks: new Map(),
        routineLinks: new Map(),
        notificationAutomationClaims: new Map(),
      },
    });

    expect(loadedButEmpty.completeness).toBe("full");
  });

  it("reports full when the link evidence is present", () => {
    const ok = compose({
      recurringSourceFailed: false,
      recurringSourceIndexes: {
        automationLinks: new Map(),
        routineLinks: new Map(),
        notificationAutomationClaims: new Map(),
      },
    });

    expect(ok.completeness).toBe("full");
  });
});

describe("recurring staff delegations survive at every consumer boundary", () => {
  /**
   * The review finding this pins: a recurring DELEGATION automation creates a
   * separately accountable obligation per firing, so an older unconfirmed or
   * escalated manifestation must stay visible everywhere.
   */
  function delegationTail() {
    const tasks: Task[] = [];
    const runs: Array<{ task_id: string; automation_id: string; user_id: string }> = [];
    for (let i = 0; i < 4; i++) {
      const id = `deleg-${i}`;
      tasks.push(
        task({
          id,
          type: "delegation",
          description: "bring the car around.",
          assigned_to: "Christopher",
          needs_follow_up: true,
          escalated_at: i === 3 ? "2026-09-23T00:39:57.000Z" : null,
          created_at: `2026-09-${String(26 - i).padStart(2, "0")}T12:15:00.000Z`,
        }),
      );
      runs.push({ task_id: id, automation_id: AUTOMATION, user_id: OWNER });
    }
    return {
      tasks,
      recurringSourceIndexes: {
        automationLinks: indexAutomationSourceLinks(runs),
        routineLinks: new Map(),
        notificationAutomationClaims: new Map(),
      },
    };
  }

  it("keeps every recurring delegation manifestation in the OPEN block", () => {
    const { tasks, recurringSourceIndexes } = delegationTail();

    const context = buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes });
    const open = openBlockLines(context);

    expect(open).toHaveLength(4);
    expect(open.filter((l) => l.includes("Christopher"))).toHaveLength(4);
  });

  it("keeps the escalated one in the attention evidence", () => {
    const { tasks, recurringSourceIndexes } = delegationTail();

    const evidence = composeAttentionEvidence({
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
    } as never) as unknown as Record<string, Array<{ id: string }>>;

    const ids = [
      ...evidence.needsYou,
      ...evidence.overdueReminders,
      ...evidence.upcomingReminders,
      ...evidence.waiting,
      ...evidence.later,
    ].map((i) => i.id);

    expect(ids).toContain("deleg-3");
  });
});

describe("material items share the current membership", () => {
  /**
   * Review finding: deriveNightSweepMaterialItems was the one sibling left
   * unnarrowed, so a stale overdue recurring manifestation still became a
   * MaterialItem and got spoken as new/changed material in an evening follow-up
   * session — re-surfacing exactly what the spoken sweep now omits.
   */
  function overdueRecurringTail() {
    const tasks: Task[] = [];
    const runs: Array<{ task_id: string; automation_id: string; user_id: string }> = [];
    for (let i = 0; i < 6; i++) {
      const id = `rec-${i}`;
      const day = String(26 - i).padStart(2, "0");
      tasks.push(
        task({
          id,
          type: "reminder",
          description: "Update the Rahet Bal master plan.",
          // Overdue, so it is material on the overdue path.
          due_at: `2026-09-${day}T12:00:00.000Z`,
          created_at: `2026-09-${day}T11:15:00.000Z`,
        }),
      );
      runs.push({ task_id: id, automation_id: AUTOMATION, user_id: OWNER });
    }
    return {
      tasks,
      recurringSourceIndexes: {
        automationLinks: indexAutomationSourceLinks(runs),
        routineLinks: new Map(),
        notificationAutomationClaims: new Map(),
      },
    };
  }

  it("night-sweep material items drop superseded recurring manifestations", () => {
    const { tasks, recurringSourceIndexes } = overdueRecurringTail();

    const before = deriveNightSweepMaterialItems(tasks, digest(), [], NOW, []);
    const after = deriveNightSweepMaterialItems(
      tasks,
      digest({ recurringSourceIndexes }),
      [],
      NOW,
      [],
    );

    const recurringIds = (items: Array<{ id: string }>) =>
      items.map((i) => i.id).filter((id) => id.startsWith("rec-"));

    expect(recurringIds(before).length).toBeGreaterThan(1);
    expect(recurringIds(after).length).toBeLessThanOrEqual(1);
    for (const id of recurringIds(after)) expect(id).toBe("rec-0");
    // Nothing new appeared.
    for (const item of after) expect(before.map((b) => b.id)).toContain(item.id);
  });

  it("morning-brief material items do the same", () => {
    const { tasks, recurringSourceIndexes } = overdueRecurringTail();

    const before = deriveMorningBriefMaterialItems(tasks, [], digest(), [], NOW, []);
    const after = deriveMorningBriefMaterialItems(
      tasks,
      [],
      digest({ recurringSourceIndexes }),
      [],
      NOW,
      [],
    );

    const count = (items: Array<{ id: string }>) =>
      items.map((i) => i.id).filter((id) => id.startsWith("rec-")).length;

    expect(count(after)).toBeLessThanOrEqual(count(before));
    expect(count(after)).toBeLessThanOrEqual(1);
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

// ─────────────────────────────────────────────────────────────────────────────
// P3 step 2 — bounded OPEN context prioritization (2026-10-02)
//
// Production 2026-10-02: after P3 5b supersession the owner had 17 CURRENT open
// items (5 current recurring manifestations + 12 genuine responsibilities).
// The OPEN window is 15 and newest-first, and a recurring source's current
// manifestation is always among the newest rows, so the two oldest genuine
// overdue reminders ("Check my mailbox", "Call Loulya") fell out of the
// session-start context. Only membership under overflow changes: genuine
// responsibilities are kept first, current recurring manifestations take the
// remaining capacity, and the kept rows still render newest-first.
// ─────────────────────────────────────────────────────────────────────────────

/** `sources` daily recurring sources (each with a superseded tail) + `genuine` older genuine items. */
function overflowShape({ sources, genuine, tail = 3 }: { sources: number; genuine: number; tail?: number }) {
  const tasks: Task[] = [];
  const runs: Array<{ task_id: string; automation_id: string; user_id: string }> = [];
  for (let s = 0; s < sources; s++) {
    for (let d = 0; d < tail; d++) {
      const id = `rec-${s}-${d}`;
      tasks.push(
        task({
          id,
          type: "action",
          description: `Recurring source ${s}`,
          // d = 0 is the newest manifestation of source s.
          created_at: new Date(Date.UTC(2026, 9, 2 - d, 10 + s)).toISOString(),
        }),
      );
      runs.push({ task_id: id, automation_id: `automation-${s}`, user_id: OWNER });
    }
  }
  for (let g = 0; g < genuine; g++) {
    tasks.push(
      task({
        id: `gen-${g}`,
        type: "reminder",
        description: `Genuine responsibility ${g}`,
        // g = genuine - 1 is the oldest, so it is the first to fall out newest-first.
        created_at: new Date(Date.UTC(2026, 7, 28 - g, 9)).toISOString(),
      }),
    );
  }
  tasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const recurringSourceIndexes = {
    automationLinks: indexAutomationSourceLinks(runs),
    routineLinks: indexRoutineSourceLinks([] as never),
    notificationAutomationClaims: indexNotificationAutomationClaims([] as never),
  };
  return { tasks, recurringSourceIndexes };
}

describe("carson-context OPEN — bounded-context prioritization (P3 step 2)", () => {
  it("<=15 current items: every current item is shown, newest-first, exactly as before", () => {
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 5, genuine: 8 });
    const context = buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes });
    const open = openBlockLines(context);

    expect(open).toHaveLength(13);
    expect(context).not.toContain("(showing 15 of");
    expect(open.filter((l) => l.includes("Recurring source"))).toHaveLength(5);
    expect(open.filter((l) => l.includes("Genuine responsibility"))).toHaveLength(8);
    // Newest-first rendering is unchanged: the recurring rows (October) precede the genuine rows (August).
    const firstGenuine = open.findIndex((l) => l.includes("Genuine responsibility"));
    expect(open.slice(0, firstGenuine).every((l) => l.includes("Recurring source"))).toBe(true);
  });

  it(">15 current items: no genuine responsibility is omitted while a recurring manifestation holds a slot", () => {
    // The 2026-10-02 Production shape: 5 current recurring + 12 genuine = 17.
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 5, genuine: 12 });
    const context = buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes });
    const open = openBlockLines(context);

    expect(open).toHaveLength(15);
    for (let g = 0; g < 12; g++) {
      expect(open.some((l) => l.endsWith(`: Genuine responsibility ${g}`))).toBe(true);
    }
    // The two oldest genuine items are the ones newest-first truncation used to drop.
    expect(open.some((l) => l.endsWith(": Genuine responsibility 11"))).toBe(true);
    expect(open.some((l) => l.endsWith(": Genuine responsibility 10"))).toBe(true);
  });

  it("current recurring manifestations keep the remaining capacity, newest first", () => {
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 5, genuine: 12 });
    const open = openBlockLines(buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes }));

    const recurring = open.filter((l) => l.includes("Recurring source"));
    // 15 - 12 genuine = 3 slots, given to the three newest current manifestations (sources 4, 3, 2).
    expect(recurring).toHaveLength(3);
    expect(recurring[0]).toContain("Recurring source 4");
    expect(recurring[1]).toContain("Recurring source 3");
    expect(recurring[2]).toContain("Recurring source 2");
    // The kept rows still render newest-first: recurring (October) before genuine (August).
    expect(open.slice(0, 3).every((l) => l.includes("Recurring source"))).toBe(true);
  });

  it("superseded recurring manifestations stay excluded exactly as P3 5b derives them", () => {
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 5, genuine: 12, tail: 6 });
    const open = openBlockLines(buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes }));

    for (let s = 0; s < 5; s++) {
      expect(open.filter((l) => l.endsWith(`: Recurring source ${s}`)).length).toBeLessThanOrEqual(1);
    }
    // Total open count in the notice counts CURRENT items only (5 + 12), not the 30-row tail.
    expect(buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes })).toContain(
      "(showing 15 of 17 open items)",
    );
  });

  it("recurring delegations stay under the accountability guard and are never deprioritized", () => {
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 5, genuine: 10 });
    const runs = [
      { task_id: "deleg-a", automation_id: "automation-deleg", user_id: OWNER },
      { task_id: "deleg-b", automation_id: "automation-deleg", user_id: OWNER },
    ];
    const delegations = runs.map((r, i) =>
      task({
        id: r.task_id,
        type: "delegation",
        description: `Recurring delegation ${i}`,
        assigned_to: "Christopher",
        needs_follow_up: true,
        escalated_at: "2026-09-14T00:39:57.000Z",
        created_at: `2026-07-${String(10 - i).padStart(2, "0")}T09:00:00.000Z`,
      }),
    );
    const allTasks = [...tasks, ...delegations];
    const indexes = {
      ...recurringSourceIndexes,
      automationLinks: indexAutomationSourceLinks([
        ...overflowShapeRuns(5, 3),
        ...runs,
      ]),
    };
    const context = buildCarsonContext({ tasks: allTasks, people: [], now: NOW, recurringSourceIndexes: indexes });
    const open = openBlockLines(context);

    // 5 recurring + 10 genuine + 2 delegations = 17; both delegations are the OLDEST rows yet both stay.
    expect(context).toContain("(showing 15 of 17 open items)");
    expect(open.some((l) => l.endsWith(": Recurring delegation 0"))).toBe(true);
    expect(open.some((l) => l.endsWith(": Recurring delegation 1"))).toBe(true);
    expect(open.filter((l) => l.includes("Genuine responsibility"))).toHaveLength(10);
    expect(open.filter((l) => l.includes("Recurring source"))).toHaveLength(3);
  });

  it("ambiguous items keep the fail-safe: they are treated as genuine and kept", () => {
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 5, genuine: 11 });
    // Claimed by an automation run AND a routine notification -> ambiguous -> never superseded, never deprioritized.
    const ambiguous = task({
      id: "ambiguous-1",
      type: "action",
      description: "Ambiguous recurring-looking item",
      created_at: "2026-07-01T09:00:00.000Z",
    });
    const notifications = [
      { target_id: "ambiguous-1", kind: "routine_reminder", user_id: OWNER, metadata: { routine_id: ROUTINE } },
    ];
    const indexes = {
      automationLinks: indexAutomationSourceLinks([
        ...overflowShapeRuns(5, 3),
        { task_id: "ambiguous-1", automation_id: "automation-x", user_id: OWNER },
      ]),
      routineLinks: indexRoutineSourceLinks(notifications as never),
      notificationAutomationClaims: indexNotificationAutomationClaims(notifications as never),
    };
    void recurringSourceIndexes;
    const context = buildCarsonContext({ tasks: [...tasks, ambiguous], people: [], now: NOW, recurringSourceIndexes: indexes });
    const open = openBlockLines(context);

    // 5 recurring + 11 genuine + 1 ambiguous = 17; the ambiguous row is the oldest and is still kept.
    expect(context).toContain("(showing 15 of 17 open items)");
    expect(open.some((l) => l.endsWith(": Ambiguous recurring-looking item"))).toBe(true);
    expect(open.filter((l) => l.includes("Recurring source"))).toHaveLength(3);
  });

  it("when genuine items alone exceed the window, the newest 15 genuine items are shown", () => {
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 2, genuine: 16 });
    const context = buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes });
    const open = openBlockLines(context);

    expect(context).toContain("(showing 15 of 18 open items)");
    expect(open).toHaveLength(15);
    expect(open.every((l) => l.includes("Genuine responsibility"))).toBe(true);
    expect(open.some((l) => l.endsWith(": Genuine responsibility 15"))).toBe(false);
  });

  it("the N-of-M notice stays truthful and appears only when the window is exceeded", () => {
    const over = overflowShape({ sources: 5, genuine: 12 });
    const at = overflowShape({ sources: 5, genuine: 10 });
    const overCtx = buildCarsonContext({ tasks: over.tasks, people: [], now: NOW, recurringSourceIndexes: over.recurringSourceIndexes });
    const atCtx = buildCarsonContext({ tasks: at.tasks, people: [], now: NOW, recurringSourceIndexes: at.recurringSourceIndexes });

    expect(overCtx).toContain("(showing 15 of 17 open items)");
    expect(openBlockLines(overCtx)).toHaveLength(15);
    expect(atCtx).not.toContain("(showing 15 of");
    expect(openBlockLines(atCtx)).toHaveLength(15);
  });

  it("context construction performs no writes to its inputs", () => {
    const { tasks, recurringSourceIndexes } = overflowShape({ sources: 5, genuine: 12 });
    const snapshot = JSON.stringify(tasks);
    for (const t of tasks) Object.freeze(t);
    Object.freeze(tasks);

    expect(() => buildCarsonContext({ tasks, people: [], now: NOW, recurringSourceIndexes })).not.toThrow();
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });
});

function overflowShapeRuns(sources: number, tail: number) {
  const runs: Array<{ task_id: string; automation_id: string; user_id: string }> = [];
  for (let s = 0; s < sources; s++) {
    for (let d = 0; d < tail; d++) runs.push({ task_id: `rec-${s}-${d}`, automation_id: `automation-${s}`, user_id: OWNER });
  }
  return runs;
}
