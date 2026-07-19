import { describe, expect, it } from "vitest";
import { getNeedsYouTimestampLabel } from "./needs-you-timestamp";
import type { Task } from "../types/task";

const NOW = new Date("2026-07-19T12:00:00.000Z");

// Match the implementation's own locale-based formatting instead of
// hardcoding a wall-clock string, so this test passes regardless of the
// machine's local timezone.
function timeStr(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function dateStr(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "plate the chicken",
    type: "delegation",
    assigned_to: "Christopher",
    status: "pending",
    needs_follow_up: false,
    confirmation_url: "https://ra7etbal.com/confirm?task=task-1",
    confirmed_at: null,
    due_at: null,
    archived_at: null,
    created_at: "2026-07-18T10:00:00.000Z",
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

describe("getNeedsYouTimestampLabel — truthful Needs You timestamps, never invented", () => {
  it("uses quality_reviewed_at when the task needs an owner review or decision", () => {
    const reviewedAt = "2026-07-19T09:00:00.000Z";
    const task = makeTask({
      quality_review_status: "uncertain",
      quality_reviewed_at: reviewedAt,
      created_at: "2026-07-18T10:00:00.000Z",
    });
    expect(getNeedsYouTimestampLabel(task, NOW)).toBe(`Reviewed today at ${timeStr(reviewedAt)}`);
  });

  it("uses escalated_at when the task was escalated and has no owner-review status", () => {
    const escalatedAt = "2026-07-19T08:30:00.000Z";
    const task = makeTask({
      escalated_at: escalatedAt,
      created_at: "2026-07-18T10:00:00.000Z",
    });
    expect(getNeedsYouTimestampLabel(task, NOW)).toBe(`Escalated today at ${timeStr(escalatedAt)}`);
  });

  it("prefers quality_reviewed_at over escalated_at when both exist", () => {
    const reviewedAt = "2026-07-19T09:00:00.000Z";
    const task = makeTask({
      quality_review_status: "substitute_review",
      quality_reviewed_at: reviewedAt,
      escalated_at: "2026-07-19T08:30:00.000Z",
    });
    expect(getNeedsYouTimestampLabel(task, NOW)).toBe(`Reviewed today at ${timeStr(reviewedAt)}`);
  });

  it("uses the existing reminder due-time formatting for overdue/due-today reminders", () => {
    const dueAt = "2026-07-19T07:00:00.000Z";
    const task = makeTask({
      type: "reminder",
      assigned_to: null,
      due_at: dueAt,
    });
    expect(getNeedsYouTimestampLabel(task, NOW)).toBe(`Due: Today at ${timeStr(dueAt)}`);
  });

  it("falls back to a plain, truthfully-labeled Created time when no more specific event exists", () => {
    const createdAt = "2026-07-17T10:00:00.000Z";
    const task = makeTask({
      type: "action",
      assigned_to: null,
      created_at: createdAt,
    });
    expect(getNeedsYouTimestampLabel(task, NOW)).toBe(`Created ${dateStr(createdAt)} at ${timeStr(createdAt)}`);
  });

  it("never invents a value — returns null when even created_at is missing/invalid", () => {
    const task = makeTask({ type: "action", assigned_to: null, created_at: "" });
    expect(getNeedsYouTimestampLabel(task, NOW)).toBeNull();
  });
});
