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
    dismissed_at: null,
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
    ...overrides,
  };
}

describe("selectConfirmationNotices", () => {
  it("excludes a server-dismissed confirmation after any fresh task reload", () => {
    const task = makeTask({ dismissed_at: "2026-07-09T12:05:00.000Z" });
    expect(selectConfirmationNotices([task])).toEqual([]);
  });

  it("shows a done confirmed delegation that has not been dismissed", () => {
    expect(selectConfirmationNotices([makeTask()]).map((task) => task.id)).toEqual(["task-1"]);
  });

  it("never shows pending, unconfirmed, or non-delegation work", () => {
    const tasks = [
      makeTask({ id: "pending", status: "pending", confirmed_at: null }),
      makeTask({ id: "self-done", confirmed_at: null }),
      makeTask({ id: "reminder", type: "reminder" }),
    ];
    expect(selectConfirmationNotices(tasks)).toEqual([]);
  });

  it("dismisses only the selected task row", () => {
    const dismissed = makeTask({ id: "task-1", dismissed_at: NOW.toISOString() });
    const visible = makeTask({
      id: "task-2",
      confirmed_at: new Date(NOW.getTime() + 1000).toISOString(),
    });
    expect(selectConfirmationNotices([dismissed, visible]).map((task) => task.id)).toEqual([
      "task-2",
    ]);
  });
});
