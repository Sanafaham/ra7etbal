/**
 * P3 5b — derived recurring-manifestation supersession.
 *
 * The rule under test: a recurring manifestation is CURRENT only when no
 * strictly newer unresolved manifestation from the same recurring source exists
 * for the same user. Supersession is derived only — these tests also pin the
 * fail-safe direction (never hide work when evidence is incomplete) and the
 * absence of write side effects.
 */

import { describe, it, expect } from "vitest";
import {
  RESOLUTION_AMBIGUOUS,
  RESOLUTION_RESOLVED,
  RESOLUTION_UNRESOLVED,
  collectSupersededManifestationIds,
  deriveRecurringManifestationState,
  indexAutomationSourceLinks,
  indexNotificationAutomationClaims,
  indexRoutineSourceLinks,
  resolveRecurringSource,
  withoutSupersededManifestations,
} from "../../shared/carson-recurring-manifestations.js";

const OWNER = "645ddb96-6e09-4d91-b650-cbc75bac9a5d";
const OTHER_USER = "11111111-1111-4111-8111-111111111111";
const AUTOMATION_A = "2b0153f2-b779-40b8-bd62-f06d5cbb07d5";
const AUTOMATION_B = "1ab27f48-bd9b-4483-b441-8043391d3c39";
const ROUTINE_A = "39869df9-a024-4d70-b3d9-642714bb4492";
const ROUTINE_B = "c27a30e2-cafc-44f3-8c64-ab65a1803a4d";

interface TestTask {
  id: string;
  user_id: string;
  status: string;
  created_at: string;
  archived_at?: string | null;
  dismissed_at?: string | null;
  type?: string;
  description?: string;
  confirmed_at?: string | null;
}

function task(over: Partial<TestTask> & { id: string; created_at: string }): TestTask {
  return {
    user_id: OWNER,
    status: "pending",
    archived_at: null,
    dismissed_at: null,
    type: "action",
    description: "Update the Rahet Bal master plan.",
    confirmed_at: null,
    ...over,
  };
}

function automationRun(taskId: string, automationId: string, userId = OWNER) {
  return { task_id: taskId, automation_id: automationId, user_id: userId };
}

function routineNotification(taskId: string, routineId: string, userId = OWNER) {
  return {
    target_id: taskId,
    kind: "routine_reminder",
    user_id: userId,
    metadata: { routine_id: routineId },
  };
}

function automationNotification(taskId: string, automationId: string, userId = OWNER) {
  return {
    target_id: taskId,
    kind: "automation_run",
    user_id: userId,
    metadata: { automation_id: automationId, automation_run_id: "run-x" },
  };
}

function indexesFor(runs: ReturnType<typeof automationRun>[], notifications: object[] = []) {
  return {
    automationLinks: indexAutomationSourceLinks(runs),
    routineLinks: indexRoutineSourceLinks(notifications as never),
    notificationAutomationClaims: indexNotificationAutomationClaims(notifications as never),
  };
}

describe("supersession — newest retained, older superseded", () => {
  it("keeps only the newest manifestation of one automation source", () => {
    const tasks = [
      task({ id: "t3", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "t2", created_at: "2026-09-25T12:15:00Z" }),
      task({ id: "t1", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("t1", AUTOMATION_A),
      automationRun("t2", AUTOMATION_A),
      automationRun("t3", AUTOMATION_A),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("t3")?.isCurrent).toBe(true);
    expect(state.get("t2")?.isCurrent).toBe(false);
    expect(state.get("t1")?.isCurrent).toBe(false);
    expect(state.get("t3")?.sourceKey).toBe(`automation:${AUTOMATION_A}`);
    expect(state.get("t1")?.resolution).toBe(RESOLUTION_RESOLVED);
  });

  it("keeps only the newest manifestation of one routine source", () => {
    const tasks = [
      task({ id: "r2", created_at: "2026-09-26T22:10:00Z" }),
      task({ id: "r1", created_at: "2026-09-25T22:10:00Z" }),
    ];
    const indexes = indexesFor([], [
      routineNotification("r1", ROUTINE_A),
      routineNotification("r2", ROUTINE_A),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("r2")?.isCurrent).toBe(true);
    expect(state.get("r1")?.isCurrent).toBe(false);
    expect(state.get("r2")?.sourceKey).toBe(`routine:${ROUTINE_A}`);
  });

  it("input order does not affect the outcome", () => {
    const newest = task({ id: "t3", created_at: "2026-09-26T12:15:00Z" });
    const oldest = task({ id: "t1", created_at: "2026-09-24T12:15:00Z" });
    const indexes = indexesFor([
      automationRun("t1", AUTOMATION_A),
      automationRun("t3", AUTOMATION_A),
    ]);

    const ascending = deriveRecurringManifestationState([oldest, newest], indexes);
    const descending = deriveRecurringManifestationState([newest, oldest], indexes);

    expect(ascending.get("t3")?.isCurrent).toBe(true);
    expect(ascending.get("t1")?.isCurrent).toBe(false);
    expect(descending.get("t3")?.isCurrent).toBe(true);
    expect(descending.get("t1")?.isCurrent).toBe(false);
  });

  it("an exact created_at tie leaves both CURRENT rather than picking one", () => {
    const tasks = [
      task({ id: "tieA", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "tieB", created_at: "2026-09-26T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("tieA", AUTOMATION_A),
      automationRun("tieB", AUTOMATION_A),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("tieA")?.isCurrent).toBe(true);
    expect(state.get("tieB")?.isCurrent).toBe(true);
  });
});

describe("supersession boundaries — sources and users never cross", () => {
  it("different automation sources never supersede one another", () => {
    const tasks = [
      task({ id: "a_new", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "b_old", created_at: "2026-09-24T01:36:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("a_new", AUTOMATION_A),
      automationRun("b_old", AUTOMATION_B),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("a_new")?.isCurrent).toBe(true);
    expect(state.get("b_old")?.isCurrent).toBe(true);
  });

  it("a routine source never supersedes an automation source", () => {
    const tasks = [
      task({ id: "routine_new", created_at: "2026-09-26T22:10:00Z" }),
      task({ id: "automation_old", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor(
      [automationRun("automation_old", AUTOMATION_A)],
      [routineNotification("routine_new", ROUTINE_A)],
    );

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("routine_new")?.isCurrent).toBe(true);
    expect(state.get("automation_old")?.isCurrent).toBe(true);
  });

  it("different routine sources never supersede one another", () => {
    const tasks = [
      task({ id: "ra", created_at: "2026-09-26T22:10:00Z" }),
      task({ id: "rb", created_at: "2026-09-24T14:30:00Z" }),
    ];
    const indexes = indexesFor([], [
      routineNotification("ra", ROUTINE_A),
      routineNotification("rb", ROUTINE_B),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("ra")?.isCurrent).toBe(true);
    expect(state.get("rb")?.isCurrent).toBe(true);
  });

  it("a newer manifestation for a DIFFERENT user never supersedes the owner's", () => {
    const tasks = [
      task({ id: "other_new", user_id: OTHER_USER, created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "owner_old", user_id: OWNER, created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("other_new", AUTOMATION_A, OTHER_USER),
      automationRun("owner_old", AUTOMATION_A, OWNER),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("owner_old")?.isCurrent).toBe(true);
    expect(state.get("other_new")?.isCurrent).toBe(true);
  });

  it("a run whose user disagrees with the task is ambiguous, never superseded", () => {
    const tasks = [
      task({ id: "newest", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "crossed", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("newest", AUTOMATION_A, OWNER),
      automationRun("crossed", AUTOMATION_A, OTHER_USER),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("crossed")?.resolution).toBe(RESOLUTION_AMBIGUOUS);
    expect(state.get("crossed")?.isCurrent).toBe(true);
  });
});

describe("source resolution", () => {
  it("resolves an automation source from the authoritative run relationship", () => {
    const t = task({ id: "t1", created_at: "2026-09-26T12:15:00Z" });
    const resolved = resolveRecurringSource(t, indexesFor([automationRun("t1", AUTOMATION_A)]));

    expect(resolved).toEqual({
      sourceKey: `automation:${AUTOMATION_A}`,
      resolution: RESOLUTION_RESOLVED,
    });
  });

  it("resolves a routine source from the notification relationship", () => {
    const t = task({ id: "r1", created_at: "2026-09-26T22:10:00Z" });
    const resolved = resolveRecurringSource(t, indexesFor([], [routineNotification("r1", ROUTINE_A)]));

    expect(resolved).toEqual({
      sourceKey: `routine:${ROUTINE_A}`,
      resolution: RESOLUTION_RESOLVED,
    });
  });

  it("accepts a run and a corroborating notification that agree", () => {
    const t = task({ id: "t1", created_at: "2026-09-26T12:15:00Z" });
    const resolved = resolveRecurringSource(
      t,
      indexesFor([automationRun("t1", AUTOMATION_A)], [automationNotification("t1", AUTOMATION_A)]),
    );

    expect(resolved.resolution).toBe(RESOLUTION_RESOLVED);
    expect(resolved.sourceKey).toBe(`automation:${AUTOMATION_A}`);
  });

  it("treats disagreement between run and notification as ambiguous, and never supersedes", () => {
    const tasks = [
      task({ id: "newest", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "disputed", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor(
      [automationRun("newest", AUTOMATION_A), automationRun("disputed", AUTOMATION_A)],
      [automationNotification("disputed", AUTOMATION_B)],
    );

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("disputed")?.resolution).toBe(RESOLUTION_AMBIGUOUS);
    expect(state.get("disputed")?.sourceKey).toBeNull();
    expect(state.get("disputed")?.isCurrent).toBe(true);
    // The undisputed newest is unaffected by its neighbour's ambiguity.
    expect(state.get("newest")?.isCurrent).toBe(true);
  });

  it("a task claimed by two different automations is ambiguous, never superseded", () => {
    const tasks = [
      task({ id: "newest", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "doubled", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("newest", AUTOMATION_A),
      automationRun("doubled", AUTOMATION_A),
      automationRun("doubled", AUTOMATION_B),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("doubled")?.resolution).toBe(RESOLUTION_AMBIGUOUS);
    expect(state.get("doubled")?.isCurrent).toBe(true);
  });

  it("a task claimed by both channels is ambiguous, never superseded", () => {
    const tasks = [
      task({ id: "newest", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "collided", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor(
      [automationRun("newest", AUTOMATION_A), automationRun("collided", AUTOMATION_A)],
      [routineNotification("collided", ROUTINE_A)],
    );

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("collided")?.resolution).toBe(RESOLUTION_AMBIGUOUS);
    expect(state.get("collided")?.isCurrent).toBe(true);
  });

  it("missing source evidence is unresolved and stays visible", () => {
    const tasks = [
      task({ id: "newest", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "orphan", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([automationRun("newest", AUTOMATION_A)]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("orphan")?.resolution).toBe(RESOLUTION_UNRESOLVED);
    expect(state.get("orphan")?.sourceKey).toBeNull();
    expect(state.get("orphan")?.isCurrent).toBe(true);
  });

  it("ignores notification kinds that are not routine_reminder", () => {
    const t = task({ id: "x1", created_at: "2026-09-26T12:15:00Z" });
    const notThatKind = {
      target_id: "x1",
      kind: "reminder_due",
      user_id: OWNER,
      metadata: { routine_id: ROUTINE_A },
    };

    const resolved = resolveRecurringSource(t, indexesFor([], [notThatKind]));

    expect(resolved.resolution).toBe(RESOLUTION_UNRESOLVED);
  });

  it("ignores malformed or blank routine and automation ids", () => {
    const blankRoutine = {
      target_id: "x1",
      kind: "routine_reminder",
      user_id: OWNER,
      metadata: { routine_id: "   " },
    };
    const nonStringRoutine = {
      target_id: "x2",
      kind: "routine_reminder",
      user_id: OWNER,
      metadata: { routine_id: 42 },
    };

    expect(indexRoutineSourceLinks([blankRoutine, nonStringRoutine] as never).size).toBe(0);
    expect(indexNotificationAutomationClaims([{ target_id: "x3", metadata: null }] as never).size).toBe(0);
    expect(indexAutomationSourceLinks([{ task_id: "x4", automation_id: null }] as never).size).toBe(0);
  });

  it("never uses description or title as identity", () => {
    // Same text, genuinely different obligations, no source evidence at all.
    const tasks = [
      task({ id: "text1", created_at: "2026-09-26T12:15:00Z", description: "Call Loulya" }),
      task({ id: "text2", created_at: "2026-09-20T19:23:52Z", description: "Call Loulya" }),
      task({ id: "text3", created_at: "2026-08-25T14:13:24Z", description: "Call Loulya" }),
    ];

    const superseded = collectSupersededManifestationIds(tasks, indexesFor([]));

    expect(superseded.size).toBe(0);
  });
});

describe("failed runs — source identity is separate from execution outcome", () => {
  it("a failed run still names its source, and supersession changes no outcome field", () => {
    // The real 2026-09-13 orphan shape: a failed run, and NO notification row
    // at all because the owner push never landed.
    const orphan = task({ id: "446f2210", created_at: "2026-09-13T12:15:09.643962Z" });
    const newer = task({ id: "newest", created_at: "2026-09-26T12:15:01.984962Z" });
    const failedRun = {
      ...automationRun("446f2210", AUTOMATION_A),
      current_state: "failed",
      failure_reason: "Owner push notification was not delivered (no enabled subscription or every send failed).",
    };
    const runs = [failedRun, automationRun("newest", AUTOMATION_A)];

    const state = deriveRecurringManifestationState([newer, orphan], indexesFor(runs));

    // Identity established from the failed run.
    expect(state.get("446f2210")?.sourceKey).toBe(`automation:${AUTOMATION_A}`);
    expect(state.get("446f2210")?.resolution).toBe(RESOLUTION_RESOLVED);
    // Superseded as a stale manifestation...
    expect(state.get("446f2210")?.isCurrent).toBe(false);
    // ...without representing the run as successful or touching the task.
    expect(failedRun.current_state).toBe("failed");
    expect(failedRun.failure_reason).toContain("was not delivered");
    expect(orphan.status).toBe("pending");
    expect(orphan.confirmed_at).toBeNull();
    expect(orphan.archived_at).toBeNull();
    expect(orphan.dismissed_at).toBeNull();
  });

  it("absence of notification evidence is not disagreement when a run exists", () => {
    const orphan = task({ id: "446f2210", created_at: "2026-09-13T12:15:09Z" });
    const resolved = resolveRecurringSource(
      orphan,
      indexesFor([automationRun("446f2210", AUTOMATION_A)], []),
    );

    expect(resolved.resolution).toBe(RESOLUTION_RESOLVED);
  });
});

describe("non-recurring and resolved work is untouched", () => {
  it("leaves plain reminders, delegations and ad-hoc tasks CURRENT", () => {
    const tasks = [
      task({ id: "rem", type: "reminder", created_at: "2026-09-20T19:23:52Z", description: "Call Loulya" }),
      task({ id: "del", type: "delegation", created_at: "2026-09-17T15:47:14Z", description: "Make a pizza for dinner." }),
      task({ id: "adhoc", type: "action", created_at: "2026-08-25T14:13:24Z", description: "Check my mailbox" }),
    ];

    const superseded = collectSupersededManifestationIds(tasks, indexesFor([]));

    expect(superseded.size).toBe(0);
  });

  it("a completed manifestation neither supersedes nor is superseded", () => {
    const tasks = [
      task({
        id: "done_newer",
        status: "done",
        confirmed_at: "2026-09-26T13:00:00Z",
        created_at: "2026-09-26T12:15:00Z",
      }),
      task({ id: "pending_older", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("done_newer", AUTOMATION_A),
      automationRun("pending_older", AUTOMATION_A),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    // A genuine confirmation is history, not a supersession signal.
    expect(state.get("done_newer")?.resolution).toBe(RESOLUTION_UNRESOLVED);
    expect(state.get("done_newer")?.isCurrent).toBe(true);
    expect(state.get("pending_older")?.isCurrent).toBe(true);
  });

  it("archived and dismissed manifestations take no part", () => {
    const tasks = [
      task({ id: "archived", archived_at: "2026-09-26T13:00:00Z", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "dismissed", dismissed_at: "2026-09-26T13:00:00Z", created_at: "2026-09-25T12:15:00Z" }),
      task({ id: "pending_older", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("archived", AUTOMATION_A),
      automationRun("dismissed", AUTOMATION_A),
      automationRun("pending_older", AUTOMATION_A),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("archived")?.isCurrent).toBe(true);
    expect(state.get("dismissed")?.isCurrent).toBe(true);
    // Nothing newer and unresolved exists, so the sole pending row stays CURRENT.
    expect(state.get("pending_older")?.isCurrent).toBe(true);
  });

  it("an unusable created_at is never superseded", () => {
    const tasks = [
      task({ id: "good", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "bad", created_at: "not-a-date" }),
    ];
    const indexes = indexesFor([
      automationRun("good", AUTOMATION_A),
      automationRun("bad", AUTOMATION_A),
    ]);

    const state = deriveRecurringManifestationState(tasks, indexes);

    expect(state.get("bad")?.isCurrent).toBe(true);
  });
});

describe("purity — idempotent, no write side effects", () => {
  it("is idempotent across repeated derivations", () => {
    const tasks = [
      task({ id: "t3", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "t2", created_at: "2026-09-25T12:15:00Z" }),
      task({ id: "t1", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const indexes = indexesFor([
      automationRun("t1", AUTOMATION_A),
      automationRun("t2", AUTOMATION_A),
      automationRun("t3", AUTOMATION_A),
    ]);

    const first = collectSupersededManifestationIds(tasks, indexes);
    const second = collectSupersededManifestationIds(tasks, indexes);
    const third = collectSupersededManifestationIds(
      withoutSupersededManifestations(tasks, first),
      indexes,
    );

    expect([...first].sort()).toEqual(["t1", "t2"]);
    expect([...second].sort()).toEqual(["t1", "t2"]);
    // Re-deriving over the already-filtered list removes nothing further.
    expect(third.size).toBe(0);
  });

  it("mutates neither the task list nor the task objects", () => {
    const tasks = [
      task({ id: "t2", created_at: "2026-09-26T12:15:00Z" }),
      task({ id: "t1", created_at: "2026-09-24T12:15:00Z" }),
    ];
    const snapshot = JSON.stringify(tasks);
    const indexes = indexesFor([
      automationRun("t1", AUTOMATION_A),
      automationRun("t2", AUTOMATION_A),
    ]);

    deriveRecurringManifestationState(tasks, indexes);
    collectSupersededManifestationIds(tasks, indexes);
    withoutSupersededManifestations(tasks, new Set(["t1"]));

    expect(JSON.stringify(tasks)).toBe(snapshot);
    expect(tasks).toHaveLength(2);
  });

  it("returns the same array instance when nothing is superseded", () => {
    const tasks = [task({ id: "t1", created_at: "2026-09-26T12:15:00Z" })];
    expect(withoutSupersededManifestations(tasks, new Set())).toBe(tasks);
    expect(withoutSupersededManifestations(tasks, null)).toBe(tasks);
  });

  it("tolerates empty and missing inputs without throwing", () => {
    expect(deriveRecurringManifestationState(null, null).size).toBe(0);
    expect(deriveRecurringManifestationState([], {}).size).toBe(0);
    expect(collectSupersededManifestationIds(undefined, undefined).size).toBe(0);
    expect(withoutSupersededManifestations(null, new Set(["x"]))).toEqual([]);
  });
});

describe("bounded-state regression — stale history cannot consume the window", () => {
  /**
   * Reproduces the measured 2026-09-26 Production shape: five daily recurring
   * sources with a long unresolved tail, plus ten genuine responsibilities.
   * Before the correction the newest-first bounded 15 is entirely recurring and
   * every genuine responsibility is invisible.
   */
  function productionShape() {
    const tasks: TestTask[] = [];
    const runs: ReturnType<typeof automationRun>[] = [];
    const notifications: object[] = [];

    const automationSources = [AUTOMATION_A, AUTOMATION_B, "a5b54e58-43a0-4a00-8353-71d8755e6abd"];
    const routineSources = [ROUTINE_A, ROUTINE_B];

    // 26 daily manifestations per source, newest 2026-09-26.
    for (let i = 0; i < 26; i++) {
      const day = 26 - i;
      const stamp = `2026-09-${String(day).padStart(2, "0")}T12:15:00Z`;
      automationSources.forEach((automationId, s) => {
        const id = `auto-${s}-${i}`;
        tasks.push(task({ id, created_at: stamp }));
        runs.push(automationRun(id, automationId));
      });
      routineSources.forEach((routineId, s) => {
        const id = `routine-${s}-${i}`;
        tasks.push(task({ id, created_at: `2026-09-${String(day).padStart(2, "0")}T22:10:00Z` }));
        notifications.push(routineNotification(id, routineId));
      });
    }

    const genuine: TestTask[] = [
      task({ id: "g1", type: "reminder", created_at: "2026-09-20T19:23:52Z" }),
      task({ id: "g2", type: "delegation", created_at: "2026-09-17T15:47:14Z" }),
      task({ id: "g3", type: "delegation", created_at: "2026-09-15T06:24:30Z" }),
      task({ id: "g4", type: "delegation", created_at: "2026-09-14T00:19:57Z" }),
      task({ id: "g5", type: "reminder", created_at: "2026-09-08T18:37:19Z" }),
      task({ id: "g6", type: "reminder", created_at: "2026-08-27T20:13:17Z" }),
      task({ id: "g7", type: "reminder", created_at: "2026-08-27T19:56:00Z" }),
      task({ id: "g8", type: "reminder", created_at: "2026-08-25T16:17:41Z" }),
      task({ id: "g9", type: "reminder", created_at: "2026-08-25T14:50:07Z" }),
      task({ id: "g10", type: "reminder", created_at: "2026-08-25T14:13:24Z" }),
    ];
    tasks.push(...genuine);

    // The real read order: newest first.
    tasks.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    return { tasks, indexes: indexesFor(runs, notifications), genuineIds: genuine.map((g) => g.id) };
  }

  it("proves the defect: without the correction no genuine responsibility reaches the bounded 15", () => {
    const { tasks, genuineIds } = productionShape();

    const window = tasks.slice(0, 15).map((t) => t.id);

    expect(window.some((id) => genuineIds.includes(id))).toBe(false);
  });

  it("after the correction the bounded 15 is exactly 5 current recurring + all 10 genuine", () => {
    const { tasks, indexes, genuineIds } = productionShape();

    const superseded = collectSupersededManifestationIds(tasks, indexes);
    const corrected = withoutSupersededManifestations(tasks, superseded);
    const window = corrected.slice(0, 15);
    const windowIds = window.map((t) => t.id);

    // 5 sources x 26 manifestations = 130 recurring; 5 stay CURRENT, 125 drop out.
    expect(superseded.size).toBe(125);
    expect(corrected).toHaveLength(15);

    const currentRecurring = windowIds.filter((id) => !genuineIds.includes(id));
    expect(currentRecurring).toHaveLength(5);

    // Every genuine responsibility is visible.
    for (const id of genuineIds) {
      expect(windowIds).toContain(id);
    }
  });

  it("historical manifestations still exist in the source list, unchanged", () => {
    const { tasks, indexes } = productionShape();
    const before = tasks.length;

    const superseded = collectSupersededManifestationIds(tasks, indexes);
    withoutSupersededManifestations(tasks, superseded);

    // Derivation removed nothing from the underlying data.
    expect(tasks).toHaveLength(before);
    for (const t of tasks) {
      expect(t.status).toBe("pending");
      expect(t.confirmed_at).toBeNull();
      expect(t.archived_at).toBeNull();
      expect(t.dismissed_at).toBeNull();
    }
  });
});
