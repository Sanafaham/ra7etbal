import { describe, expect, it, vi } from "vitest";

// morning-brief.ts -> calendar.ts / automation-context.ts import ./supabase
// at module top level, which throws without VITE_SUPABASE_* env vars. Stub
// it the same way automation-context.test.ts / carson-material-items.test.ts
// do — only the pure taskLabel() categorizer is exercised here, no real
// Supabase client is ever used.
vi.mock("./supabase", () => ({ supabase: {} }));

const { taskLabel, buildCompletionPhrase, buildMorningBriefSpoken, isMaterialWaitingItem } = await import("./morning-brief");

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
  return { pending: [], escalated: [], failed: [], confirmedToday: [], firingToday: [], firingTomorrow: [], ...overrides };
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

describe("buildMorningBriefSpoken — Needs You (distinct from Waiting On Others)", () => {
  it("a genuine owner decision surfaces and is not phrased as 'waiting on others'", () => {
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW, [], undefined, [
      { id: "esc-1", staffName: "Christopher", inboundText: "done?", escalationReason: null, receivedAt: NOW.toISOString(), taskId: null, decisionId: "dec-1", deepLinkToken: "tok" },
    ]);
    expect(spoken).toContain("One decision needs you — Christopher is waiting on an answer.");
    expect(spoken).not.toMatch(/waiting on others/i);
  });
});
