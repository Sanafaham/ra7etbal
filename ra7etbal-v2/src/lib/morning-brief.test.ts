import { describe, expect, it, vi } from "vitest";

// morning-brief.ts -> calendar.ts / automation-context.ts import ./supabase
// at module top level, which throws without VITE_SUPABASE_* env vars. Stub
// it the same way automation-context.test.ts / carson-material-items.test.ts
// do — only the pure taskLabel() categorizer is exercised here, no real
// Supabase client is ever used.
vi.mock("./supabase", () => ({ supabase: {} }));

const { taskLabel, buildCompletionPhrase, buildMorningBriefSpoken, buildMorningBrief, isMaterialWaitingItem } = await import("./morning-brief");

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

const NOW = new Date("2026-08-18T09:00:00.000Z");

describe("taskLabel", () => {
  // Production incident (2026-08-18): a task with "kitchen" in the description
  // ("Clean the kitchen.") was spoken as "Christopher confirmed food task" —
  // the bare word "kitchen" alone incorrectly matched the food/groceries
  // category. The task was a cleaning chore, not food-related at all.
  it("does not label a plain kitchen-cleaning task as a food task", () => {
    expect(taskLabel("Clean the kitchen.")).not.toBe("food task");
  });

  it("falls back to a lowercased, punctuation-stripped phrase for a kitchen-cleaning task", () => {
    expect(taskLabel("Clean the kitchen.")).toBe("clean the kitchen");
  });

  // Existing food/grocery categorization must be unaffected.
  it("still labels groceries as a food task", () => {
    expect(taskLabel("Buy groceries for the week")).toBe("food task");
  });

  it("still labels grocery (singular) as a food task", () => {
    expect(taskLabel("Buy grocery items for the week")).toBe("food task");
  });

  it("still labels a bare food mention as a food task", () => {
    expect(taskLabel("Order food for the party")).toBe("food task");
  });

  it("still labels cat food as a cat food task", () => {
    expect(taskLabel("Buy cat food")).toBe("cat food task");
  });

  it("still labels flowers as a flowers request", () => {
    expect(taskLabel("Order flowers for the office")).toBe("flowers request");
  });

  it("still labels a car/pickup task as a car task", () => {
    expect(taskLabel("Pick up the dry cleaning")).toBe("car task");
  });

  it("still labels a delivery task as a delivery task", () => {
    expect(taskLabel("Wait for the courier")).toBe("delivery task");
  });

  it("still labels a bill/utility task as a bill task", () => {
    expect(taskLabel("Pay the electric bill")).toBe("bill task");
  });

  // Production incident (2026-08-21): a delegation dictated directly to the
  // assignee ("Christopher, we have 6 guests for dinner tomorrow at 8:00
  // PM. Please plan and prepare a full dinner menu with NO shellfish.
  // Confirm your menu plan with me by end of day today so we can finalize
  // any shopping needed. Let me know if you have questions on guest
  // preferences.") was spoken back as "christopher, we have 6 guests for…"
  // inside the Waiting sentence "Christopher still hasn't confirmed the
  // [fragment]." — the assignee's own name was lowercased and reinserted,
  // and the raw multi-sentence utterance was truncated mid-thought with a
  // trailing "…." (ellipsis collided with the template's own period).
  it("labels the real production Christopher/six-guest dinner description as a dinner plan, not a mangled name fragment", () => {
    const label = taskLabel(
      "Christopher, we have 6 guests for dinner tomorrow at 8:00 PM. Please plan and prepare a full dinner menu with NO shellfish. Confirm your menu plan with me by end of day today so we can finalize any shopping needed. Let me know if you have questions on guest preferences.",
    );
    expect(label).toBe("dinner plan");
    expect(label).not.toContain("christopher");
    expect(label).not.toContain("…");
  });

  it("the full owner-facing Waiting sentence for the real Christopher record is coherent, not malformed", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Christopher",
      description:
        "Christopher, we have 6 guests for dinner tomorrow at 8:00 PM. Please plan and prepare a full dinner menu with NO shellfish. Confirm your menu plan with me by end of day today so we can finalize any shopping needed. Let me know if you have questions on guest preferences.",
      escalated_at: "2026-08-19T13:55:35.443Z",
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).toContain("Christopher still hasn't confirmed the dinner plan.");
    expect(spoken).not.toContain("christopher");
    expect(spoken).not.toContain("….");
    expect(spoken).not.toContain("…");
  });

  // General coverage for the failure class, independent of the "dinner"
  // keyword match above — an ordinary description beginning with a
  // person's proper name and comma, with no food/dinner/guest vocabulary,
  // must not have that name lowercased into the fallback label.
  it("does not lowercase a leading proper-noun vocative address with no keyword match", () => {
    const label = taskLabel("Grace, please water the plants on the balcony every morning before breakfast");
    expect(label).not.toMatch(/^grace/);
    expect(label).not.toContain("grace,");
  });

  // A day name directly followed by a comma is not a person's name and
  // must be preserved, not treated as a vocative address.
  it("does not strip a leading day name that happens to be followed by a comma", () => {
    expect(taskLabel("Monday, water the plants")).toBe("monday, water the plants");
  });

  // General coverage: any description long enough to hit the truncation
  // path must never end in an ellipsis, since every caller appends its own
  // sentence-final period.
  it("truncates a long description without a trailing ellipsis", () => {
    const label = taskLabel(
      "Reorganize the entire garage including all tools, boxes, seasonal decorations, and the old furniture that has been sitting there for months",
    );
    expect(label.length).toBeLessThanOrEqual(35);
    expect(label).not.toMatch(/…$/);
    expect(label).not.toMatch(/\.$/);
  });

  // Ordinary, already-passing Waiting/delegation case — confirms the fix
  // does not change behavior for a ordinary short imperative description.
  it("still produces the normal fallback phrase for an ordinary short delegation description", () => {
    expect(taskLabel("Tidy the living room shelves")).toBe("tidy the living room shelves");
  });
});

describe("isMaterialWaitingItem — consequence-based, not age-based", () => {
  it("age alone does not qualify a waiting item, no matter how stale", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: "2020-01-01T00:00:00.000Z",
    });
    expect(isMaterialWaitingItem(task, NOW)).toBe(false);
  });

  it("escalation qualifies", () => {
    const task = makeTask({ escalated_at: NOW.toISOString() });
    expect(isMaterialWaitingItem(task, NOW)).toBe(true);
  });

  it("an overdue due_at qualifies", () => {
    const task = makeTask({ due_at: new Date(NOW.getTime() - 1000).toISOString() });
    expect(isMaterialWaitingItem(task, NOW)).toBe(true);
  });

  it("a due_at later today qualifies", () => {
    const task = makeTask({ due_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() });
    expect(isMaterialWaitingItem(task, NOW)).toBe(true);
  });

  it("a due_at tomorrow does not qualify", () => {
    const task = makeTask({ due_at: new Date(NOW.getTime() + 25 * 60 * 60 * 1000).toISOString() });
    expect(isMaterialWaitingItem(task, NOW)).toBe(false);
  });

  it("quality_review_status 'uncertain' qualifies (owner decision required)", () => {
    const task = makeTask({ quality_review_status: "uncertain" });
    expect(isMaterialWaitingItem(task, NOW)).toBe(true);
  });

  it("quality_review_status 'substitute_review' qualifies (owner decision required)", () => {
    const task = makeTask({ quality_review_status: "substitute_review" });
    expect(isMaterialWaitingItem(task, NOW)).toBe(true);
  });

  it("quality_review_status 'correction_required' does not by itself qualify (operational, not an owner decision)", () => {
    const task = makeTask({ quality_review_status: "correction_required" });
    expect(isMaterialWaitingItem(task, NOW)).toBe(false);
  });

  it("no signal at all does not qualify", () => {
    const task = makeTask({});
    expect(isMaterialWaitingItem(task, NOW)).toBe(false);
  });
});

describe("buildCompletionPhrase — natural outcome language", () => {
  it("'Clean the kitchen.' becomes a gerund outcome phrase, not a mislabeled category", () => {
    expect(buildCompletionPhrase("Clean the kitchen.")).toEqual({ text: "cleaning the kitchen", isGerund: true });
  });

  it("descriptions not starting with a mapped verb fall back to taskLabel()", () => {
    expect(buildCompletionPhrase("Buy groceries for the week")).toEqual({ text: "food task", isGerund: false });
  });
});

describe("buildMorningBriefSpoken — 'Clean the kitchen' completion (Chief-of-Staff contract)", () => {
  it("never says 'food task'; speaks a natural outcome instead", () => {
    const task = makeTask({
      description: "Clean the kitchen.",
      type: "delegation",
      assigned_to: "Christopher",
      status: "done",
      confirmed_at: "2026-08-18T08:00:00.000Z",
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).not.toContain("food task");
    expect(spoken).toContain("Christopher finished cleaning the kitchen.");
  });
});

describe("buildMorningBriefSpoken — quiet morning may legitimately be short", () => {
  it("nothing to report is a short greeting, not filled with low-value information", () => {
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW);
    expect(spoken).toBe("Good morning Sana. Your calendar is clear today. You're clear for the rest of the day.");
  });
});

describe("buildMorningBriefSpoken — routine waiting items are excluded (Chief-of-Staff contract)", () => {
  it("a fresh, non-escalated waiting item is not spoken merely because it exists", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).not.toMatch(/waiting|confirm/i);
  });

  it("an escalated waiting item is spoken", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      escalated_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).toContain("Grace still hasn't confirmed");
  });

  // Chief-of-Staff contract (2026-08-18, second pass): age alone is never
  // sufficient relevance — a routine delegation that has simply sat for a
  // while, with no escalation, deadline, or owner-decision signal, is not
  // spoken merely because time passed.
  it("a waiting item stale for many days with no other signal is NOT spoken", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).not.toMatch(/Grace/);
  });

  it("a waiting item that is overdue (due_at in the past) is spoken, regardless of age", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      due_at: new Date(NOW.getTime() - 30 * 60 * 1000).toISOString(),
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).toContain("Grace needs to confirm");
  });

  it("a waiting item due later today is spoken", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      due_at: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).toContain("Grace needs to confirm");
  });

  it("a waiting item flagged for owner review (quality_review_status) is spoken", () => {
    const task = makeTask({
      type: "delegation",
      assigned_to: "Grace",
      status: "pending",
      created_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
      quality_review_status: "substitute_review",
    });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW);
    expect(spoken).toContain("needs your review");
  });
});

describe("buildMorningBriefSpoken — routine automation status is excluded entirely", () => {
  it("4 routine pending automations produce no automation sentence", () => {
    const digest = emptyDigest({
      pending: [
        { id: "a1", automationTitle: "Daily Claude skill files check", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a2", automationTitle: "Morning phone charge reminder", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a3", automationTitle: "Daily reminder test", assignee: null, sentAgoMs: 0, isFollowupSent: false },
        { id: "a4", automationTitle: "Update Rahet Bal master plan", assignee: null, sentAgoMs: 0, isFollowupSent: false },
      ],
    });
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW, [], digest);
    expect(spoken).not.toMatch(/waiting for confirmation|automation/i);
  });
});

// Production incident (2026-08-18, live acceptance round 2): a recurring
// automation's routine (unconfirmed, non-escalated) run creates a linked
// `tasks` row (automation_runs.task_id). That task row bypassed the
// automation relevance contract entirely — buildMorningBrief's
// needsAttention filter has no relevance gate for non-reminder task types,
// so Carson said "One task needs your attention — Update the Ra7etBal
// master plan. ... Charge your phone. ... And 4 more things to cover."
// even though the automation-status sentence itself was correctly silent.
// buildMorningBrief now accepts routineAutomationTaskIds (from
// AutomationDigest) and excludes any task whose id is in that set from
// both needsAttention and overdueItems — the task inherits its linked
// automation run's relevance decision rather than being treated as an
// ordinary owner task.
describe("buildMorningBrief / buildMorningBriefSpoken — automation-linked task inherits automation relevance (Chief-of-Staff contract)", () => {
  it("A: a task linked to a routine automation run is excluded from needsAttention", () => {
    const task = makeTask({ id: "task-linked-1", type: "action", description: "Update the Rahet Bal master plan." });
    const routineAutomationTaskIds = new Set(["task-linked-1"]);
    const brief = buildMorningBrief([task], [], NOW, routineAutomationTaskIds);
    expect(brief.needsAttention.find((t) => t.id === "task-linked-1")).toBeUndefined();
  });

  it("A (spoken): the same routine automation-linked task never reaches the spoken brief", () => {
    const task = makeTask({ id: "task-linked-1", type: "action", description: "Update the Rahet Bal master plan." });
    const digest = emptyDigest({ routineAutomationTaskIds: new Set(["task-linked-1"]) });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW, [], digest);
    expect(spoken).not.toContain("Update the Rahet Bal master plan");
    expect(spoken).not.toMatch(/needs your attention/i);
  });

  it("B: an ordinary action task with no automation link is NOT accidentally suppressed", () => {
    const task = makeTask({ id: "task-ordinary-1", type: "action", description: "Book the vet appointment." });
    const routineAutomationTaskIds = new Set(["some-other-task-id"]);
    const brief = buildMorningBrief([task], [], NOW, routineAutomationTaskIds);
    expect(brief.needsAttention.find((t) => t.id === "task-ordinary-1")).toBeDefined();
  });

  it("B (spoken): an ordinary, non-automation-linked action task still surfaces", () => {
    const task = makeTask({ id: "task-ordinary-1", type: "action", description: "Book the vet appointment." });
    const digest = emptyDigest({ routineAutomationTaskIds: new Set() });
    const spoken = buildMorningBriefSpoken([task], [], "Sana", NOW, [], digest);
    expect(spoken).toContain("Book the vet appointment");
  });

  it("C: a task is not excluded merely because SOME OTHER task is automation-linked", () => {
    const linkedTask = makeTask({ id: "task-linked-1", type: "action", description: "Update the Rahet Bal master plan." });
    const ordinaryTask = makeTask({ id: "task-ordinary-1", type: "action", description: "Book the vet appointment." });
    const routineAutomationTaskIds = new Set(["task-linked-1"]);
    const brief = buildMorningBrief([linkedTask, ordinaryTask], [], NOW, routineAutomationTaskIds);
    expect(brief.needsAttention.map((t) => t.id)).not.toContain("task-linked-1");
    expect(brief.needsAttention.map((t) => t.id)).toContain("task-ordinary-1");
  });

  it("C: a task linked to a FAILED automation run still surfaces (only routine-state runs are excluded)", () => {
    const task = makeTask({ id: "task-failed-1", type: "action", description: "Update the Rahet Bal master plan." });
    // routineAutomationTaskIds only ever contains sent/followup_sent-linked
    // task ids (see automation-context.ts) — a failed run's task is never
    // added to it, so it is untouched here, exactly as for an ordinary task.
    const routineAutomationTaskIds = new Set<string>();
    const brief = buildMorningBrief([task], [], NOW, routineAutomationTaskIds);
    expect(brief.needsAttention.find((t) => t.id === "task-failed-1")).toBeDefined();
  });

  it("D: a task linked to an ESCALATED automation run still surfaces (only routine-state runs are excluded)", () => {
    const task = makeTask({ id: "task-escalated-1", type: "action", description: "check on Claude skill files" });
    const routineAutomationTaskIds = new Set<string>();
    const brief = buildMorningBrief([task], [], NOW, routineAutomationTaskIds);
    expect(brief.needsAttention.find((t) => t.id === "task-escalated-1")).toBeDefined();
  });

  it("F: hidden routine automation-linked tasks are excluded from the material-item follow-up count, not just the first-session brief", () => {
    const routineTask = makeTask({ id: "task-linked-1", type: "action", description: "Update the Rahet Bal master plan." });
    const digest = emptyDigest({ routineAutomationTaskIds: new Set(["task-linked-1"]) });
    // The full first-session brief must not mention it either — this is the
    // upstream guarantee that carson-material-items.ts's follow-up "N more"
    // count (built from the same buildMorningBrief() call) inherits.
    const spoken = buildMorningBriefSpoken([routineTask], [], "Sana", NOW, [], digest);
    expect(spoken).not.toMatch(/Update the Rahet Bal master plan|needs your attention/i);
  });

  it("G: multiple task rows linked to routine runs (repeat firings of the same automation) are all excluded", () => {
    const tasks = [
      makeTask({ id: "run-aug12", type: "action", description: "Charge your phone", created_at: "2026-08-12T22:36:01.000Z" }),
      makeTask({ id: "run-aug17", type: "action", description: "Charge your phone", created_at: "2026-08-17T22:36:01.000Z" }),
      makeTask({ id: "run-aug18", type: "action", description: "Charge your phone", created_at: "2026-08-18T08:36:01.000Z" }),
    ];
    const routineAutomationTaskIds = new Set(["run-aug12", "run-aug17", "run-aug18"]);
    const brief = buildMorningBrief(tasks, [], NOW, routineAutomationTaskIds);
    expect(brief.needsAttention).toEqual([]);
  });
});

describe("buildMorningBriefSpoken — Needs You (distinct from Waiting On Others)", () => {
  it("a genuine owner decision surfaces and is not phrased as 'waiting on others'", () => {
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW, [], undefined, [
      { id: "esc-1", staffName: "Christopher", inboundText: "done?", escalationReason: null, receivedAt: NOW.toISOString(), taskId: null, decisionId: "dec-1", deepLinkToken: "tok" },
    ]);
    expect(spoken).toContain("One decision needs you — Christopher is waiting on an answer.");
    expect(spoken).not.toMatch(/waiting on others/i);
  });
});
