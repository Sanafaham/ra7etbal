import { describe, expect, it } from "vitest";
import { selectConfirmationNotices } from "./dismissed-notifications";
import type { Task } from "../types/task";

const NOW = new Date("2026-07-09T12:00:00.000Z");

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "plate the chicken",
    type: "delegation",
    assigned_to: "Christopher",
    status: "done",
    needs_follow_up: false,
    confirmation_url: "https://ra7etbal.com/confirm?task=task-1",
    confirmed_at: NOW.toISOString(),
    due_at: null,
    archived_at: null,
    created_at: "2026-07-09T10:00:00.000Z",
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
  } as Task;
}

describe("selectConfirmationNotices — server-backed dismissal (tasks.dismissed_at)", () => {
  it("a dismissed, done, confirmed task is excluded — this is the selector excluding dismissed completed confirmations", () => {
    const task = makeTask({ id: "task-1", dismissed_at: "2026-07-09T12:05:00.000Z" });
    const visible = selectConfirmationNotices([task]);
    expect(visible.map((t) => t.id)).not.toContain("task-1");
  });

  it("a done, confirmed task that has NOT been dismissed still appears", () => {
    const task = makeTask({ id: "task-1", dismissed_at: null });
    const visible = selectConfirmationNotices([task]);
    expect(visible.map((t) => t.id)).toContain("task-1");
  });

  it("protected: a pending (unresolved, not yet confirmed) delegation never appears, dismissed_at or not", () => {
    const pending = makeTask({ id: "task-pending", status: "pending", confirmed_at: null, dismissed_at: null });
    expect(selectConfirmationNotices([pending]).map((t) => t.id)).not.toContain("task-pending");

    // Even if dismissed_at were somehow set on a pending task (should never
    // happen — dismissConfirmationNotices guards this at the write layer —
    // the selector's own status/confirmed_at filter is the real invariant).
    const pendingWithStrayDismissal = makeTask({
      id: "task-pending-2",
      status: "pending",
      confirmed_at: null,
      dismissed_at: "2026-07-09T12:05:00.000Z",
    });
    expect(selectConfirmationNotices([pendingWithStrayDismissal]).map((t) => t.id)).not.toContain(
      "task-pending-2",
    );
  });

  it("protected: a done task with no confirmed_at (e.g. owner marked done directly) never appears", () => {
    const selfDone = makeTask({ id: "task-self", confirmed_at: null, dismissed_at: null });
    expect(selectConfirmationNotices([selfDone]).map((t) => t.id)).not.toContain("task-self");
  });

  it("dismissing one task's banner does not hide a different, still-active task's banner", () => {
    const dismissedTask = makeTask({
      id: "task-1",
      confirmed_at: NOW.toISOString(),
      dismissed_at: "2026-07-09T12:05:00.000Z",
    });
    const activeTask = makeTask({
      id: "task-2",
      confirmed_at: new Date(NOW.getTime() + 1000).toISOString(),
      dismissed_at: null,
    });
    const visible = selectConfirmationNotices([dismissedTask, activeTask]);
    expect(visible.map((t) => t.id)).toEqual(["task-2"]);
  });

  it("regression: dismissal state comes from the task row itself, so it is identical regardless of storage environment (Safari, installed PWA, another device) — there is no separate client-side dismissal set to diverge", () => {
    const task = makeTask({ id: "task-1", dismissed_at: "2026-07-09T12:05:00.000Z" });
    // Simulate two independent "clients" (e.g. Safari tab vs. installed PWA)
    // evaluating the exact same server-fetched task row — same result, since
    // there is no local storage layer in between to diverge.
    const safariView = selectConfirmationNotices([task]);
    const pwaView = selectConfirmationNotices([{ ...task }]);
    expect(safariView.map((t) => t.id)).toEqual(pwaView.map((t) => t.id));
    expect(safariView.map((t) => t.id)).not.toContain("task-1");
  });
});
