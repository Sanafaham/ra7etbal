import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDailyBrief } from "./daily-brief";
import { getUpcomingReminderTasks } from "./updates-reminders";
import type { Task } from "../types/task";

const NOW = new Date("2026-06-29T04:40:00.000Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function offsetFromNow(ms: number): string {
  return new Date(NOW.getTime() + ms).toISOString();
}

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
  };
}

function sections(tasks: Task[]) {
  const brief = buildDailyBrief(tasks, NOW);
  const upcoming = getUpcomingReminderTasks(tasks, brief.needsAttention, NOW);
  return { needsYou: brief.needsAttention, upcoming };
}

/**
 * Needs You is a decision queue, not an ownership queue (see
 * isNeedsYouTask's own header comment in daily-brief.ts): only
 * task.type === "decision" qualifies. Reminders — due soon, overdue, or
 * otherwise — never appear in Needs You regardless of their due date, and
 * NOW/due_at are fixed, explicitly-injected values (never read from wall-
 * clock time), so none of this suite depends on the real calendar date.
 * vi.setSystemTime below is an additional guard: if a future change ever
 * drops the explicit `now` argument from buildDailyBrief/
 * getUpcomingReminderTasks (falling back to their own `new Date()`
 * default), these tests still run against the fixed NOW instead of
 * silently depending on wall-clock time.
 */
describe("Updates reminder sections", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a reminder due soon only in Upcoming Reminders, never in Needs You", () => {
    const task = reminder("due-soon", offsetFromNow(2 * MINUTE));
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual([]);
    expect(result.upcoming.map((item) => item.id)).toEqual(["due-soon"]);
  });

  it("shows a future reminder only in Upcoming Reminders", () => {
    const task = reminder("tomorrow", offsetFromNow(DAY + 5 * 60 * MINUTE));
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual([]);
    expect(result.upcoming.map((item) => item.id)).toEqual(["tomorrow"]);
  });

  it("removes an overdue reminder from both Needs You and Upcoming Reminders (visible via Later instead)", () => {
    const task = reminder("overdue", offsetFromNow(-30 * MINUTE));
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual([]);
    expect(result.upcoming.map((item) => item.id)).toEqual([]);
  });

  it("removes a done reminder from both sections", () => {
    const task = reminder("done", offsetFromNow(2 * MINUTE), "done");
    const result = sections([task]);

    expect(result.needsYou.map((item) => item.id)).toEqual([]);
    expect(result.upcoming.map((item) => item.id)).toEqual([]);
  });

  it("does not return duplicate Upcoming cards for the same task id", () => {
    const task = reminder("tomorrow", offsetFromNow(DAY + 5 * 60 * MINUTE));
    const result = sections([task, { ...task }]);

    expect(result.upcoming.map((item) => item.id)).toEqual(["tomorrow"]);
  });
});
