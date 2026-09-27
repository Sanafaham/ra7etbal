/**
 * P3 5b UI CONSUMER ALIGNMENT (2026-09-27).
 *
 * buildDailyBrief() is the What's Happening / Home operational consumer. It
 * received raw task-store rows and did not apply the CLOSED and PROTECTED P3 5b
 * recurring-manifestation derivation, so the UI presented superseded historical
 * manifestations as current Pending work while Carson's own attention/context
 * consumers already suppressed them.
 *
 * These tests pin the aligned behavior. They reuse the single shared derivation
 * in shared/carson-recurring-manifestations.js as the authority — no second
 * supersession algorithm, no title matching, no new responsibility state.
 *
 * The fail-safe direction is the important half: when source links are
 * unavailable, incomplete or ambiguous, the item MUST stay visible.
 */
import { describe, expect, it } from "vitest";
import { buildDailyBrief } from "./daily-brief";
import {
  indexAutomationSourceLinks,
  indexRoutineSourceLinks,
} from "../../shared/carson-recurring-manifestations.js";
import type { Task } from "../types/task";

const OWNER = "owner-user-1";

function task(over: Partial<Task> & { id: string }): Task {
  return {
    user_id: OWNER,
    type: "action",
    description: "Recurring manifestation",
    assigned_to: null,
    status: "pending",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
    needs_follow_up: false,
    due_at: null,
    confirmed_at: null,
    archived_at: null,
    dismissed_at: null,
    followup_sent_at: null,
    escalated_at: null,
    ...over,
  } as Task;
}

/** Build indexes the same way production does — from raw link rows. */
function indexesFor(
  runRows: Array<{ task_id: string; automation_id: string; user_id?: string }>,
  notificationRows: Array<{
    target_id: string;
    kind: string;
    user_id?: string;
    metadata: Record<string, unknown>;
  }> = [],
) {
  return {
    automationLinks: indexAutomationSourceLinks(
      runRows.map((r) => ({ ...r, user_id: r.user_id ?? OWNER })),
    ),
    routineLinks: indexRoutineSourceLinks(
      notificationRows.map((r) => ({ ...r, user_id: r.user_id ?? OWNER })),
    ),
  };
}

describe("buildDailyBrief — P3 5b recurring manifestation supersession", () => {
  it("1. keeps only the CURRENT manifestation of one authoritative source", () => {
    const tasks = [
      task({ id: "m1", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "m2", created_at: "2026-09-02T00:00:00.000Z" }),
      task({ id: "m3", created_at: "2026-09-03T00:00:00.000Z" }),
    ];
    const indexes = indexesFor([
      { task_id: "m1", automation_id: "auto-A" },
      { task_id: "m2", automation_id: "auto-A" },
      { task_id: "m3", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-04T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.later.map((t) => t.id)).toEqual(["m3"]);
  });

  it("2. excludes superseded manifestations from the Pending (later) bucket", () => {
    const tasks = [
      task({ id: "old", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "new", created_at: "2026-09-05T00:00:00.000Z" }),
    ];
    const indexes = indexesFor([
      { task_id: "old", automation_id: "auto-A" },
      { task_id: "new", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.later.map((t) => t.id)).not.toContain("old");
  });

  it("3. keeps the CURRENT recurring manifestation visible", () => {
    const tasks = [
      task({ id: "old", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "current", created_at: "2026-09-05T00:00:00.000Z" }),
    ];
    const indexes = indexesFor([
      { task_id: "old", automation_id: "auto-A" },
      { task_id: "current", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.later.map((t) => t.id)).toContain("current");
  });

  it("4. keeps a genuine non-recurring reminder visible", () => {
    const tasks = [
      task({ id: "m1", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "m2", created_at: "2026-09-05T00:00:00.000Z" }),
      task({
        id: "rem",
        type: "reminder",
        description: "Call Loulya",
        due_at: "2026-09-20T19:24:51.000Z",
      }),
    ];
    const indexes = indexesFor([
      { task_id: "m1", automation_id: "auto-A" },
      { task_id: "m2", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-26T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.later.map((t) => t.id)).toContain("rem");
  });

  it("5. keeps an overdue reminder visible", () => {
    const tasks = [
      task({
        id: "overdue",
        type: "reminder",
        description: "Pay bills",
        created_at: "2026-08-27T00:00:00.000Z",
        due_at: "2026-08-28T15:00:00.000Z",
      }),
    ];

    const brief = buildDailyBrief(tasks, new Date("2026-09-26T00:00:00.000Z"), {
      recurringSourceIndexes: indexesFor([]),
    });

    expect(brief.later.map((t) => t.id)).toContain("overdue");
  });

  it("6. keeps accountable tracked delegation visible (never superseded)", () => {
    // Same recurring source as the manifestations, but independently accountable.
    const tasks = [
      task({ id: "m1", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "m2", created_at: "2026-09-05T00:00:00.000Z" }),
      task({
        id: "deleg",
        type: "delegation",
        description: "Make a pizza for dinner.",
        assigned_to: "Christopher",
        needs_follow_up: true,
        created_at: "2026-09-02T00:00:00.000Z",
      }),
    ];
    const indexes = indexesFor([
      { task_id: "m1", automation_id: "auto-A" },
      { task_id: "m2", automation_id: "auto-A" },
      { task_id: "deleg", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    const allVisible = [...brief.needsAttention, ...brief.waitingOnOthers, ...brief.later];
    expect(allVisible.map((t) => t.id)).toContain("deleg");
  });

  it("7. keeps an escalated Christopher-style delegation in Waiting", () => {
    const tasks = [
      task({
        id: "escalated",
        type: "delegation",
        description: "bring the car around.",
        assigned_to: "Christopher",
        needs_follow_up: true,
        created_at: "2026-09-14T00:19:57.000Z",
        followup_sent_at: "2026-09-15T07:10:01.000Z",
        escalated_at: "2026-09-15T07:10:01.000Z",
      }),
      task({
        id: "escalated-2",
        type: "delegation",
        description: "bring the car around.",
        assigned_to: "Christopher",
        needs_follow_up: true,
        created_at: "2026-09-15T06:24:30.000Z",
        followup_sent_at: "2026-09-15T07:10:01.000Z",
        escalated_at: "2026-09-15T07:10:01.000Z",
      }),
    ];
    // Both share a recurring source link — the accountability guard must still
    // keep BOTH, so the older one is not hidden by the newer one.
    const indexes = indexesFor([
      { task_id: "escalated", automation_id: "auto-A" },
      { task_id: "escalated-2", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-26T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.waitingOnOthers.map((t) => t.id)).toEqual(
      expect.arrayContaining(["escalated", "escalated-2"]),
    );
  });

  it("8. FAIL SAFE: source-link load failure keeps every manifestation visible", () => {
    const tasks = [
      task({ id: "m1", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "m2", created_at: "2026-09-05T00:00:00.000Z" }),
    ];

    // Links failed to load — the consumer passes no indexes.
    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: undefined,
    });

    expect(brief.later.map((t) => t.id)).toEqual(expect.arrayContaining(["m1", "m2"]));
  });

  it("8b. FAIL SAFE: omitting the options argument entirely is unchanged behavior", () => {
    const tasks = [
      task({ id: "m1", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "m2", created_at: "2026-09-05T00:00:00.000Z" }),
    ];

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"));

    expect(brief.later.map((t) => t.id)).toEqual(expect.arrayContaining(["m1", "m2"]));
  });

  it("9. FAIL SAFE: ambiguous/conflicting provenance keeps the item visible", () => {
    const tasks = [
      task({ id: "ambiguous", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "clean", created_at: "2026-09-05T00:00:00.000Z" }),
    ];
    // "ambiguous" is linked to two different automations — conflict.
    const indexes = indexesFor([
      { task_id: "ambiguous", automation_id: "auto-A" },
      { task_id: "ambiguous", automation_id: "auto-B" },
      { task_id: "clean", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.later.map((t) => t.id)).toContain("ambiguous");
  });

  it("10. a source with only one manifestation is never suppressed", () => {
    const tasks = [task({ id: "only", created_at: "2026-09-01T00:00:00.000Z" })];
    const indexes = indexesFor([{ task_id: "only", automation_id: "auto-A" }]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.later.map((t) => t.id)).toEqual(["only"]);
  });

  it("11. supersession never mutates the caller's task array (history intact)", () => {
    const tasks = [
      task({ id: "m1", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "m2", created_at: "2026-09-05T00:00:00.000Z" }),
    ];
    const snapshot = tasks.map((t) => ({ ...t }));
    const indexes = indexesFor([
      { task_id: "m1", automation_id: "auto-A" },
      { task_id: "m2", automation_id: "auto-A" },
    ]);

    buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(tasks).toHaveLength(2);
    expect(tasks).toEqual(snapshot);
  });

  it("12. user isolation: same source id under a different user never supersedes", () => {
    const tasks = [
      task({ id: "mine", user_id: OWNER, created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "theirs", user_id: "other-user", created_at: "2026-09-05T00:00:00.000Z" }),
    ];
    const indexes = indexesFor([
      { task_id: "mine", automation_id: "auto-A", user_id: OWNER },
      { task_id: "theirs", automation_id: "auto-A", user_id: "other-user" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    // The newer row belongs to another user, so it must not supersede "mine".
    expect(brief.later.map((t) => t.id)).toContain("mine");
  });

  it("13. done and archived rows are still excluded exactly as before", () => {
    const tasks = [
      task({ id: "archived", archived_at: "2026-09-02T00:00:00.000Z" }),
      task({ id: "done", status: "done" }),
      task({ id: "live" }),
    ];

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexesFor([]),
    });

    expect(brief.later.map((t) => t.id)).toEqual(["live"]);
  });

  it("14. routine-backed manifestations supersede via routine provenance", () => {
    const tasks = [
      task({ id: "r1", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "r2", created_at: "2026-09-05T00:00:00.000Z" }),
    ];
    const indexes = indexesFor(
      [],
      [
        {
          target_id: "r1",
          kind: "routine_reminder",
          metadata: { routine_id: "routine-A" },
        },
        {
          target_id: "r2",
          kind: "routine_reminder",
          metadata: { routine_id: "routine-A" },
        },
      ],
    );

    const brief = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.later.map((t) => t.id)).toEqual(["r2"]);
  });

  it("16. brief.currentTasks is the post-supersession population adjacent lists must reuse", () => {
    // A future-dated reminder-typed manifestation: dropped from `later` as
    // superseded, so Updates' "Upcoming reminders" must not resurrect it. That
    // list reads brief.currentTasks, so pin what currentTasks contains.
    const tasks = [
      task({ id: "old-rem", type: "reminder", created_at: "2026-09-01T00:00:00.000Z", due_at: "2026-10-01T09:00:00.000Z" }),
      task({ id: "new-rem", type: "reminder", created_at: "2026-09-05T00:00:00.000Z", due_at: "2026-10-02T09:00:00.000Z" }),
    ];
    const indexes = indexesFor([
      { task_id: "old-rem", automation_id: "auto-A" },
      { task_id: "new-rem", automation_id: "auto-A" },
    ]);

    const brief = buildDailyBrief(tasks, new Date("2026-09-26T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    expect(brief.currentTasks.map((t) => t.id)).toEqual(["new-rem"]);
    expect(brief.currentTasks.map((t) => t.id)).not.toContain("old-rem");
  });

  it("17. currentTasks is every row when nothing is superseded (fail safe)", () => {
    const tasks = [task({ id: "a" }), task({ id: "b" })];
    const brief = buildDailyBrief(tasks, new Date("2026-09-26T00:00:00.000Z"));
    expect(brief.currentTasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("18. bottom-nav badge population cannot drift: a superseded decision row is excluded", () => {
    // The badge counts needsAttention. A `decision`-typed recurring
    // manifestation IS eligible for both needsAttention and supersession, so
    // the badge must read the same post-supersession population as Home and
    // Updates or the three surfaces disagree.
    const tasks = [
      task({ id: "old-dec", type: "decision", created_at: "2026-09-01T00:00:00.000Z" }),
      task({ id: "new-dec", type: "decision", created_at: "2026-09-05T00:00:00.000Z" }),
    ];
    const indexes = indexesFor([
      { task_id: "old-dec", automation_id: "auto-A" },
      { task_id: "new-dec", automation_id: "auto-A" },
    ]);

    const withIndexes = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });
    const withoutIndexes = buildDailyBrief(tasks, new Date("2026-09-06T00:00:00.000Z"));

    // Aligned: only the CURRENT decision counts.
    expect(withIndexes.needsAttention.map((t) => t.id)).toEqual(["new-dec"]);
    // Fail safe when links are unavailable: both still count.
    expect(withoutIndexes.needsAttention.map((t) => t.id)).toEqual(
      expect.arrayContaining(["old-dec", "new-dec"]),
    );
  });

  it("15. production-shaped population: 135 manifestations + 7 reminders + 3 delegations", () => {
    const tasks: Task[] = [];
    const runRows: Array<{ task_id: string; automation_id: string }> = [];
    const notifRows: Array<{
      target_id: string;
      kind: string;
      metadata: Record<string, unknown>;
    }> = [];

    // 3 automation sources, 27 manifestations each = 81
    for (let s = 0; s < 3; s++) {
      for (let d = 0; d < 27; d++) {
        const id = `a${s}-d${d}`;
        tasks.push(task({ id, created_at: `2026-08-${String(30 - 0).padStart(2, "0")}T00:00:00.000Z` }));
        // distinct, increasing created_at
        tasks[tasks.length - 1].created_at = new Date(
          Date.UTC(2026, 7, 30) + d * 86_400_000,
        ).toISOString();
        runRows.push({ task_id: id, automation_id: `auto-${s}` });
      }
    }
    // 2 routine sources, 27 each = 54
    for (let s = 0; s < 2; s++) {
      for (let d = 0; d < 27; d++) {
        const id = `r${s}-d${d}`;
        tasks.push(
          task({
            id,
            created_at: new Date(Date.UTC(2026, 7, 30) + d * 86_400_000).toISOString(),
          }),
        );
        notifRows.push({
          target_id: id,
          kind: "routine_reminder",
          metadata: { routine_id: `routine-${s}` },
        });
      }
    }
    // 7 genuine reminders, no recurring provenance
    for (let i = 0; i < 7; i++) {
      tasks.push(task({ id: `rem-${i}`, type: "reminder", due_at: "2026-08-28T15:00:00.000Z" }));
    }
    // 3 accountable tracked delegations
    for (let i = 0; i < 3; i++) {
      tasks.push(
        task({
          id: `deleg-${i}`,
          type: "delegation",
          assigned_to: "Christopher",
          needs_follow_up: true,
          escalated_at: "2026-09-17T16:07:15.000Z",
        }),
      );
    }

    const indexes = indexesFor(runRows, notifRows);
    const brief = buildDailyBrief(tasks, new Date("2026-09-26T00:00:00.000Z"), {
      recurringSourceIndexes: indexes,
    });

    // 5 CURRENT recurring manifestations + 7 reminders survive into `later`.
    expect(brief.later).toHaveLength(12);
    // 3 accountable delegations are in Waiting, not hidden.
    expect(brief.waitingOnOthers).toHaveLength(3);
    // Total current operational responsibilities = 15.
    expect(brief.later.length + brief.waitingOnOthers.length).toBe(15);
    // Every physical row is still in the caller's array.
    expect(tasks).toHaveLength(145);
  });
});
