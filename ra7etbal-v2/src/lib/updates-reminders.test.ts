import { describe, expect, it } from "vitest";
import { buildDailyBrief } from "./daily-brief";
import { getUpcomingReminderTasks } from "./updates-reminders";
import type { Task } from "../types/task";

const NOW = new Date("2026-06-29T04:40:00.000Z");

function reminder(
  id: string,
  dueAt: string,
  status: Task["status"] = "pending",
): Task {
  return {
    id,
    user_id: "user-1",
    description: id,
    type: "reminder",
    assigned_to: null,
    status,
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: status === "done" ? NOW.toISOString() : null,
    due_at: dueAt,
    archived_at: null,
    created_at: "2026-06-29T04:00:00.000Z",
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
  };
}

function sections(tasks: Task[]) {
  const brief = buildDailyBrief(tasks, NOW);
  const upcoming = getUpcomingReminderTasks(tasks, brief.needsAttention, NOW);
  return { needsYou: brief.needsAttention, upcoming };
}

describe("Updates reminder sections", () => {
  it("shows a reminder due soon only in Needs You", () => {
    const task = reminder("due-soon", "2026-06-29T04:42:00.000Z");
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual(["due-soon"]);
    expect(result.upcoming.map((item) => item.id)).toEqual([]);
  });

  it("shows a future reminder only in Upcoming Reminders", () => {
    const task = reminder("tomorrow", "2026-06-30T10:00:00.000Z");
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual([]);
    expect(result.upcoming.map((item) => item.id)).toEqual(["tomorrow"]);
  });

  it("shows an overdue reminder only in Needs You", () => {
    const task = reminder("overdue", "2026-06-29T04:10:00.000Z");
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual(["overdue"]);
    expect(result.upcoming.map((item) => item.id)).toEqual([]);
  });

  it("removes a done reminder from both sections", () => {
    const task = reminder("done", "2026-06-29T04:42:00.000Z", "done");
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual([]);
    expect(result.upcoming.map((item) => item.id)).toEqual([]);
  });

  it("does not return duplicate Upcoming cards for the same task id", () => {
    const task = reminder("tomorrow", "2026-06-30T10:00:00.000Z");
    const result = sections([task, { ...task }]);

    expect(result.upcoming.map((item) => item.id)).toEqual(["tomorrow"]);
  });
});
