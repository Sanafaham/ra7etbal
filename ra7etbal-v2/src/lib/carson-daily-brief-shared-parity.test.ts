import { describe, it, expect } from "vitest";
import { buildDailyBrief } from "./daily-brief";
import { buildDailyBriefBuckets } from "../../shared/carson-daily-brief-classifier.js";
import type { Task } from "../types/task";

/**
 * Documented exception (2026-08-28, structured Second Brain operational
 * evidence): shared/carson-daily-brief-classifier.js duplicates (does not
 * import) daily-brief.ts's isNeedsYouTask/isWaitingTask/isLaterTask
 * membership rules, because daily-brief.ts is the Home/Updates UI's
 * protected classifier and is explicitly out of scope to modify for this
 * slice. This test guards the two copies from drifting apart.
 */
function task(overrides: Partial<Task>): Task {
  return {
    id: "t1",
    user_id: "u1",
    description: "test",
    type: "reminder",
    assigned_to: null,
    status: "pending",
    needs_follow_up: false,
    confirmation_url: null,
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-08-28T00:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: null,
    proof_image_path: null,
    ...overrides,
  } as Task;
}

describe("buildDailyBrief vs shared buildDailyBriefBuckets — membership parity", () => {
  const now = new Date("2026-08-28T12:00:00.000Z");

  it("matches needsYou/waitingOnOthers/later membership across a representative task mix", () => {
    const tasks: Task[] = [
      task({ id: "cancelled-1", status: "cancelled" }),
      task({ id: "decision-owner", type: "decision", assigned_to: null }),
      task({ id: "decision-other", type: "decision", assigned_to: "Christopher" }),
      task({ id: "delegation-waiting", type: "delegation", assigned_to: "Christopher" }),
      task({ id: "followup-waiting", type: "followup" }),
      task({ id: "delegation-review", type: "delegation", assigned_to: "Christopher", quality_review_status: "uncertain" }),
      task({ id: "reminder-overdue", type: "reminder", due_at: "2026-08-25T14:00:00.000Z" }),
      task({ id: "reminder-today", type: "reminder", due_at: "2026-08-28T18:00:00.000Z" }),
      task({ id: "done-1", status: "done", confirmed_at: "2026-08-28T10:00:00.000Z" }),
      task({ id: "archived-1", archived_at: "2026-08-27T00:00:00.000Z" }),
    ];

    const browser = buildDailyBrief(tasks, now);
    const shared = buildDailyBriefBuckets(tasks, now);

    const ids = (list: Task[]) => list.map((t) => t.id).sort();

    expect(ids(shared.needsYou)).toEqual(ids(browser.needsAttention));
    expect(ids(shared.waitingOnOthers)).toEqual(ids(browser.waitingOnOthers));
    expect(ids(shared.later)).toEqual(ids(browser.later));
  });
});
