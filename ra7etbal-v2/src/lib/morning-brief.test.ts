import { describe, expect, it } from "vitest";
import { buildMorningBrief, buildMorningBriefSpoken } from "./morning-brief";
import type { Task } from "../types/task";

const NOW = new Date("2026-07-08T12:00:00.000Z");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "renew the passport",
    type: "reminder",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-07-08T10:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    worker_reply: null,
    dismissed_at: null,
    ...overrides,
  };
}

describe("buildMorningBriefSpoken — overdue reminders", () => {
  it("names both overdue reminders instead of dropping to a single item", () => {
    const overdueA = makeTask({
      id: "rem-1",
      description: "check on Claude skill files",
      due_at: "2026-07-07T09:00:00.000Z",
    });
    const overdueB = makeTask({
      id: "rem-2",
      description: "test this exact reminder",
      due_at: "2026-07-07T10:00:00.000Z",
    });
    const spoken = buildMorningBriefSpoken([overdueA, overdueB], [], "Sana", NOW);

    expect(spoken).toContain("Two reminders are overdue");
    expect(spoken).toContain("check on Claude skill files");
    expect(spoken).toContain("test this exact reminder");
  });

  it("names the pending reminder alongside two overdue reminders (production evidence)", () => {
    const overdueA = makeTask({
      id: "rem-1",
      description: "check on Claude skill files",
      due_at: "2026-07-07T09:00:00.000Z",
    });
    const overdueB = makeTask({
      id: "rem-2",
      description: "test this exact reminder",
      due_at: "2026-07-07T10:00:00.000Z",
    });
    const pendingToday = makeTask({
      id: "rem-3",
      description: "Test routine reminder",
      due_at: "2026-07-08T18:00:00.000Z",
    });
    const spoken = buildMorningBriefSpoken([overdueA, overdueB, pendingToday], [], "Sana", NOW);

    expect(spoken).toContain("Three things need attention today");
    expect(spoken).toContain("Two reminders are overdue: check on Claude skill files, test this exact reminder.");
    expect(spoken).toContain("Test routine reminder is still pending.");
  });

  it("does not silently drop a pending reminder when a single overdue reminder also exists", () => {
    const overdue = makeTask({
      id: "rem-1",
      description: "check on Claude skill files",
      due_at: "2026-07-07T09:00:00.000Z",
    });
    const pendingToday = makeTask({
      id: "rem-3",
      description: "Test routine reminder",
      due_at: "2026-07-08T18:00:00.000Z",
    });
    const spoken = buildMorningBriefSpoken([overdue, pendingToday], [], "Sana", NOW);

    expect(spoken).toContain("Two things need attention today");
    expect(spoken).toContain("One reminder is overdue: check on Claude skill files");
    expect(spoken).toContain("Test routine reminder is still pending.");
  });

  it("mentions only overdue reminders, with no pending clause, when no pending reminder exists", () => {
    const overdueA = makeTask({ id: "rem-1", description: "check on Claude skill files", due_at: "2026-07-07T09:00:00.000Z" });
    const overdueB = makeTask({ id: "rem-2", description: "test this exact reminder", due_at: "2026-07-07T10:00:00.000Z" });
    const spoken = buildMorningBriefSpoken([overdueA, overdueB], [], "Sana", NOW);

    expect(spoken).toContain("Two reminders are overdue: check on Claude skill files, test this exact reminder.");
    expect(spoken).not.toContain("is still pending");
  });

  it("names a lone pending reminder with no overdue clause when nothing is overdue", () => {
    const pendingToday = makeTask({ id: "rem-3", description: "Test routine reminder", due_at: "2026-07-08T18:00:00.000Z" });
    const spoken = buildMorningBriefSpoken([pendingToday], [], "Sana", NOW);

    expect(spoken).toContain("You have a reminder — Test routine reminder");
    expect(spoken).not.toContain("overdue");
  });

  it("summarizes a larger reminder backlog safely: overdue titles stay capped at two and the pending reminder is still named", () => {
    const overdue = ["rem-1", "rem-2", "rem-3", "rem-4"].map((id, i) =>
      makeTask({ id, description: `overdue item ${i}`, due_at: "2026-07-07T09:00:00.000Z" }),
    );
    const pendingToday = makeTask({ id: "rem-5", description: "Test routine reminder", due_at: "2026-07-08T18:00:00.000Z" });
    const spoken = buildMorningBriefSpoken([...overdue, pendingToday], [], "Sana", NOW);

    expect(spoken).toContain("Five things need attention today");
    expect(spoken).toContain("Four reminders are overdue: overdue item 0, overdue item 1.");
    expect(spoken).not.toContain("overdue item 2");
    expect(spoken).not.toContain("overdue item 3");
    expect(spoken).toContain("Test routine reminder is still pending.");
  });

  it("still uses the single-item phrasing when there is exactly one overdue reminder", () => {
    const overdue = makeTask({ id: "rem-1", description: "renew the passport", due_at: "2026-07-07T09:00:00.000Z" });
    const spoken = buildMorningBriefSpoken([overdue], [], "Sana", NOW);

    expect(spoken).toContain("One reminder is overdue: renew the passport.");
    expect(spoken).not.toContain("things need attention");
  });

  it("names at most two overdue reminder titles when three or more are overdue", () => {
    const overdue = ["rem-1", "rem-2", "rem-3"].map((id, i) =>
      makeTask({ id, description: `overdue item ${i}`, due_at: "2026-07-07T09:00:00.000Z" }),
    );
    const spoken = buildMorningBriefSpoken(overdue, [], "Sana", NOW);

    expect(spoken).toContain("Three reminders are overdue");
    expect(spoken).toContain("overdue item 0");
    expect(spoken).toContain("overdue item 1");
    expect(spoken).not.toContain("overdue item 2");
  });
});

describe("buildMorningBrief — staff replies needing owner review", () => {
  it("moves a substitute_review delegation out of Waiting and into Needs Attention", () => {
    const task = makeTask({
      id: "task-2",
      type: "delegation",
      description: "buy flowers",
      assigned_to: "Grace",
      quality_review_status: "substitute_review",
    });
    const brief = buildMorningBrief([task], []);

    expect(brief.waitingOn.map((t) => t.id)).not.toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).toContain(task.id);
  });

  it("moves an uncertain proof review out of Waiting and into Needs Attention", () => {
    const task = makeTask({
      id: "task-3",
      type: "delegation",
      description: "wash the car",
      assigned_to: "Ghulam",
      quality_review_status: "uncertain",
    });
    const brief = buildMorningBrief([task], []);

    expect(brief.waitingOn.map((t) => t.id)).not.toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).toContain(task.id);
  });

  it("keeps an ordinary pending delegation in Waiting, not Needs Attention", () => {
    const task = makeTask({
      id: "task-4",
      type: "delegation",
      description: "prepare dinner",
      assigned_to: "Christopher",
    });
    const brief = buildMorningBrief([task], []);

    expect(brief.waitingOn.map((t) => t.id)).toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).not.toContain(task.id);
  });
});

describe("buildMorningBriefSpoken — other open items (to-dos and notes)", () => {
  it("mentions a total count of to-dos and notes when both are non-zero", () => {
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW, [], undefined, 5, 2);
    expect(spoken).toContain("You have seven other open items in the app.");
  });

  it("says nothing extra when both counts are zero (default, backward compatible)", () => {
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW);
    expect(spoken).not.toContain("other open item");
  });

  it("uses singular phrasing for exactly one other open item", () => {
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW, [], undefined, 1, 0);
    expect(spoken).toContain("You have one other open item in the app.");
  });
});

describe("buildMorningBriefSpoken — never invents state", () => {
  it("produces a clear-day close with no urgent, waiting, or automation content for an empty task list", () => {
    const spoken = buildMorningBriefSpoken([], [], "Sana", NOW);
    expect(spoken).toContain("You're clear for the rest of the day.");
    expect(spoken).not.toContain("overdue");
    expect(spoken).not.toContain("waiting");
  });
});
