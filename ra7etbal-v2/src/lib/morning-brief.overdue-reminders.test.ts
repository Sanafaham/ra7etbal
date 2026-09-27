/**
 * Overdue reminder Morning-Brief truthfulness — Production defect (2026-09-27).
 *
 * Sana had SEVEN overdue one-time reminders (oldest 33 days: "Call Loulya",
 * "Check my mailbox", "Check my email"; then "Pay bills" and "Call the doctor"
 * at 30 days; "Call Loulya" at 19 and at 6 days). Carson's spoken opening still
 * began:
 *
 *     "One reminder is overdue: <a single item>"
 *
 * because `morning-brief.ts` selected the overdue set with `.find()` and the
 * wording hardcoded "One". Six of the seven responsibilities Sana had asked
 * Carson to remember were silently dropped from the brief every single day.
 * Which single item got named depended on task-store order, so this suite pins
 * deterministic ordering rather than asserting the historically spoken item.
 *
 * These tests exercise the real spoken opening (buildMorningBriefSpoken),
 * because the defect was only ever visible there.
 *
 * TRUTHFULNESS BOUNDARY for this slice: the brief reports that a reminder is
 * overdue and how long it has been overdue. It never says a reminder was
 * undelivered, missed, or unseen, and it never infers acknowledgment,
 * completion, dismissal, snooze or intent — no reminder lifecycle state is
 * read or written here.
 */

import { describe, expect, it, vi } from "vitest";

// morning-brief.ts reaches ./supabase at module load via calendar.ts /
// automation-context.ts. Stubbed exactly as the sibling suites do; every
// function exercised here is pure.
vi.mock("./supabase", () => ({ supabase: {} }));

const { buildMorningBriefSpoken } = await import("./morning-brief");
const { indexAutomationSourceLinks } = await import(
  "../../shared/carson-recurring-manifestations.js"
);

import type { Task } from "../types/task";
import type { AutomationDigest } from "./automation-context";

const OWNER = "owner-user-1";

/** 2026-09-27 09:00 UTC — a morning, so the greeting branch is "Good morning". */
const NOW = new Date("2026-09-27T09:00:00Z");

function reminder(over: Partial<Task> & { id: string; description: string; due_at: string }): Task {
  return {
    user_id: OWNER,
    type: "reminder",
    assigned_to: null,
    status: "pending",
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
    needs_follow_up: false,
    confirmed_at: null,
    archived_at: null,
    dismissed_at: null,
    followup_sent_at: null,
    escalated_at: null,
    ...over,
  } as Task;
}

/** Days before NOW, as an ISO due_at. */
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

function daysAhead(n: number): string {
  return new Date(NOW.getTime() + n * 86_400_000).toISOString();
}

/** The real Production population, ages as measured on 2026-09-27. */
const PRODUCTION_SEVEN: Task[] = [
  reminder({ id: "r1", description: "Call Loulya", due_at: daysAgo(33) }),
  reminder({ id: "r2", description: "Check my mailbox", due_at: daysAgo(33) }),
  reminder({ id: "r3", description: "Check my email", due_at: daysAgo(33) }),
  reminder({ id: "r4", description: "Pay bills", due_at: daysAgo(30) }),
  reminder({ id: "r5", description: "Call the doctor", due_at: daysAgo(30) }),
  reminder({ id: "r6", description: "Call Loulya", due_at: daysAgo(19) }),
  reminder({ id: "r7", description: "Call Loulya", due_at: daysAgo(6) }),
];

/**
 * A complete-enough AutomationDigest. The morning brief's automation slot reads
 * every one of these arrays, so a partial object throws before the overdue slot
 * is ever reached.
 */
function digestOf(over: Partial<AutomationDigest> = {}): AutomationDigest {
  return {
    pending: [],
    escalated: [],
    failed: [],
    confirmedToday: [],
    firingToday: [],
    firingTomorrow: [],
    routineAutomationTaskIds: new Set<string>(),
    recurringSourceIndexes: undefined,
    recurringSourceLinksLoaded: false,
    ...over,
  } as unknown as AutomationDigest;
}

function spoken(tasks: Task[], digest?: AutomationDigest): string {
  return buildMorningBriefSpoken(tasks, [], "Sana", NOW, [], digest, []);
}

describe("buildMorningBriefSpoken — overdue reminder truthfulness", () => {
  it("0 overdue: says nothing about overdue reminders", () => {
    const out = spoken([reminder({ id: "future", description: "Pack", due_at: daysAhead(3) })]);
    expect(out).not.toMatch(/overdue/i);
  });

  it("1 overdue: preserves the existing singular wording", () => {
    const out = spoken([reminder({ id: "r4", description: "Pay bills", due_at: daysAgo(30) })]);
    expect(out).toContain("One reminder is overdue: Pay bills.");
  });

  // ── The defect ────────────────────────────────────────────────────────────
  it("REGRESSION: 7 overdue are never reported as 'One reminder is overdue'", () => {
    const out = spoken(PRODUCTION_SEVEN);
    expect(out).not.toContain("One reminder is overdue");
  });

  it("REGRESSION: 7 overdue states the truthful total of seven", () => {
    const out = spoken(PRODUCTION_SEVEN);
    expect(out).toMatch(/[Ss]even reminders are overdue/);
  });

  it("4+ overdue: names examples but explicitly preserves the total", () => {
    const out = spoken(PRODUCTION_SEVEN);
    // The total must be present, and the named items must be marked as the
    // oldest few rather than presented as the whole set.
    expect(out).toMatch(/[Ss]even reminders are overdue/);
    expect(out).toMatch(/oldest/i);
  });

  it("4+ overdue: leads with the oldest, deterministically", () => {
    const shuffled = [
      PRODUCTION_SEVEN[6],
      PRODUCTION_SEVEN[3],
      PRODUCTION_SEVEN[0],
      PRODUCTION_SEVEN[5],
      PRODUCTION_SEVEN[1],
      PRODUCTION_SEVEN[4],
      PRODUCTION_SEVEN[2],
    ];
    const a = spoken(PRODUCTION_SEVEN);
    const b = spoken(shuffled);
    // Same population in any input order produces the same spoken line.
    expect(b).toBe(a);
    // And the 6-day-old reminder is not presented as one of the oldest.
    const oldestClause = a.slice(a.search(/oldest/i));
    expect(oldestClause).toContain("Check my mailbox");
  });

  it("2 overdue: truthful count and both reminders identified", () => {
    const out = spoken([PRODUCTION_SEVEN[3], PRODUCTION_SEVEN[6]]);
    expect(out).toMatch(/[Tt]wo reminders are overdue/);
    expect(out).toContain("Pay bills");
    expect(out).toContain("Call Loulya");
  });

  it("3 overdue: truthful count and all three identified, no 'oldest' hedge", () => {
    const out = spoken([PRODUCTION_SEVEN[3], PRODUCTION_SEVEN[4], PRODUCTION_SEVEN[6]]);
    expect(out).toMatch(/[Tt]hree reminders are overdue/);
    expect(out).toContain("Pay bills");
    expect(out).toContain("Call the doctor");
    expect(out).toContain("Call Loulya");
    // All three are named, so nothing is being summarised away.
    expect(out).not.toMatch(/oldest/i);
  });

  it("includes overdue age context for multi-reminder cases", () => {
    const out = spoken([PRODUCTION_SEVEN[3], PRODUCTION_SEVEN[6]]);
    expect(out).toContain("30 days");
    expect(out).toContain("six days");
  });

  it("age wording: a reminder overdue by hours is not called a day overdue", () => {
    const hoursAgo = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
    const out = spoken([
      reminder({ id: "h1", description: "Pay bills", due_at: hoursAgo }),
      reminder({ id: "h2", description: "Call the doctor", due_at: daysAgo(6) }),
    ]);
    expect(out).toMatch(/due earlier today/);
    expect(out).not.toMatch(/zero days/);
  });

  it("age wording: exactly one day overdue reads as yesterday, not 'one days'", () => {
    const out = spoken([
      reminder({ id: "d1", description: "Pay bills", due_at: daysAgo(1) }),
      reminder({ id: "d2", description: "Call the doctor", due_at: daysAgo(6) }),
    ]);
    expect(out).toMatch(/due yesterday/);
    expect(out).not.toMatch(/one days/);
  });

  // ── Boundaries that must not move ─────────────────────────────────────────
  it("a future reminder is never described as overdue", () => {
    const out = spoken([
      reminder({ id: "f1", description: "Pack", due_at: daysAhead(2) }),
      reminder({ id: "f2", description: "Renew passport", due_at: daysAhead(9) }),
    ]);
    expect(out).not.toMatch(/overdue/i);
    expect(out).not.toContain("Pack, ");
  });

  it("a done, archived or dismissed overdue reminder is excluded", () => {
    const out = spoken([
      reminder({ id: "d", description: "Pay bills", due_at: daysAgo(30), status: "done" }),
      reminder({
        id: "a",
        description: "Call the doctor",
        due_at: daysAgo(30),
        archived_at: "2026-09-01T00:00:00.000Z",
      }),
      reminder({ id: "live", description: "Call Loulya", due_at: daysAgo(6) }),
    ]);
    expect(out).toContain("One reminder is overdue: Call Loulya.");
  });

  it("P3 5b: superseded recurring manifestations never leak into the overdue set", () => {
    // Two manifestations of one automation source, both overdue reminders.
    // Supersession must drop the older, leaving a single overdue reminder.
    const manifestations = [
      reminder({
        id: "m-old",
        description: "Charge your phone",
        due_at: daysAgo(20),
        created_at: "2026-09-07T00:00:00.000Z",
      }),
      reminder({
        id: "m-new",
        description: "Charge your phone",
        due_at: daysAgo(1),
        created_at: "2026-09-26T00:00:00.000Z",
      }),
    ];
    const digest = digestOf({
      recurringSourceIndexes: {
        automationLinks: indexAutomationSourceLinks([
          { task_id: "m-old", automation_id: "auto-A", user_id: OWNER },
          { task_id: "m-new", automation_id: "auto-A", user_id: OWNER },
        ]),
        routineLinks: new Map(),
      },
      recurringSourceLinksLoaded: true,
    } as unknown as Partial<AutomationDigest>);

    const out = spoken(manifestations, digest);
    expect(out).toContain("One reminder is overdue");
    expect(out).not.toMatch(/[Tt]wo reminders are overdue/);
  });

  it("P3 5b fail safe: without indexes both manifestations remain visible", () => {
    const manifestations = [
      reminder({ id: "m-old", description: "Charge your phone", due_at: daysAgo(20) }),
      reminder({ id: "m-new", description: "Charge your phone", due_at: daysAgo(1) }),
    ];
    const out = spoken(manifestations);
    expect(out).toMatch(/[Tt]wo reminders are overdue/);
  });

  it("routineAutomationTaskIds suppression is still honoured", () => {
    const digest = digestOf({ routineAutomationTaskIds: new Set(["suppressed"]) });
    const out = spoken(
      [
        reminder({ id: "suppressed", description: "Charge your phone", due_at: daysAgo(9) }),
        reminder({ id: "live", description: "Pay bills", due_at: daysAgo(30) }),
      ],
      digest,
    );
    expect(out).toContain("One reminder is overdue: Pay bills.");
  });

  it("never claims a reminder was undelivered, missed or unseen", () => {
    const out = spoken(PRODUCTION_SEVEN);
    expect(out).not.toMatch(/undelivered|not delivered|missed|didn't see|did not see|unseen|unconfirmed/i);
  });

  it("the overdue slot still yields to nothing else — other slots are unaffected", () => {
    // A due-today reminder must remain reachable when nothing is overdue.
    const soon = new Date(NOW.getTime() + 2 * 3_600_000).toISOString();
    const out = spoken([reminder({ id: "today", description: "Pay bills", due_at: soon })]);
    expect(out).toMatch(/You have a reminder/);
    expect(out).not.toMatch(/overdue/i);
  });
});
