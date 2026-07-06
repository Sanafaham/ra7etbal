import { describe, expect, it } from "vitest";
import { buildDailyBrief } from "./daily-brief";
import type { Task } from "../types/task";

const NOW = new Date("2026-07-08T12:00:00.000Z");

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
    created_at: "2026-07-08T10:00:00.000Z",
    qstash_message_id: null,
    followup_sent_at: null,
    escalated_at: null,
    image_path: "task-images/user-1/task-1/photo.jpg",
    proof_image_path: null,
    quality_review_status: null,
    quality_review_note: null,
    quality_reviewed_at: null,
    ...overrides,
  };
}

/**
 * Production incident: Christopher uploaded the wrong proof photo (correctly
 * flagged, task stayed Waiting), then uploaded a corrected photo — but
 * Carson's automated review came back "uncertain" (not clearly approved), so
 * the task remained in Waiting for Confirmation indefinitely, indistinguishable
 * from a task Christopher simply hadn't responded to yet. In reality the ball
 * had already moved to the owner (Sana) — Carson explicitly pushes the owner
 * for a manual decision on uncertain/fraud_suspected outcomes and never
 * messages the assignee again for those two outcomes. "Waiting" must mean
 * "waiting on the other person"; once quality review escalates to the owner,
 * the task belongs in "Needs You" instead.
 */
describe("daily-brief — quality-review-aware Waiting / Needs You classification", () => {
  it("an uncertain proof review moves the task out of Waiting and into Needs You", () => {
    const task = makeTask({ quality_review_status: "uncertain", quality_review_note: "No reference image to compare against." });
    const brief = buildDailyBrief([task], NOW);
    expect(brief.waitingOnOthers.map((t) => t.id)).not.toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).toContain(task.id);
  });

  it("a fraud_suspected proof review moves the task out of Waiting and into Needs You", () => {
    const task = makeTask({ quality_review_status: "fraud_suspected", quality_review_note: "This is the reference image, not a new photo." });
    const brief = buildDailyBrief([task], NOW);
    expect(brief.waitingOnOthers.map((t) => t.id)).not.toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).toContain(task.id);
  });

  it("protected: a correction_required proof review stays in Waiting — Carson already asked the assignee to resubmit", () => {
    const task = makeTask({ quality_review_status: "correction_required", quality_review_note: "Please center the chicken." });
    const brief = buildDailyBrief([task], NOW);
    expect(brief.waitingOnOthers.map((t) => t.id)).toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).not.toContain(task.id);
  });

  it("protected: a normal delegation with no quality review yet is unaffected — still Waiting, not Needs You", () => {
    const task = makeTask({ quality_review_status: null });
    const brief = buildDailyBrief([task], NOW);
    expect(brief.waitingOnOthers.map((t) => t.id)).toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).not.toContain(task.id);
  });

  it("protected: an approved review (task done) is excluded from both buckets, same as before", () => {
    const task = makeTask({ status: "done", quality_review_status: "approved", confirmed_at: NOW.toISOString() });
    const brief = buildDailyBrief([task], NOW);
    expect(brief.waitingOnOthers.map((t) => t.id)).not.toContain(task.id);
    expect(brief.needsAttention.map((t) => t.id)).not.toContain(task.id);
  });

  it("protected: a cancelled delegation still reaches Needs You — the pre-existing intervention path is untouched", () => {
    const task = makeTask({ status: "cancelled" });
    const brief = buildDailyBrief([task], NOW);
    expect(brief.needsAttention.map((t) => t.id)).toContain(task.id);
  });

  it("protected: normal text-only confirmation flow — a plain delegation with no photo still classifies as Waiting until confirmed", () => {
    // "Suresh confirmed 'call me'" scenario: no image_path, no quality review
    // involved at all — this must be completely unaffected by the proof-photo fix.
    const task = makeTask({
      description: "call me",
      assigned_to: "Suresh",
      image_path: null,
      quality_review_status: null,
    });
    const brief = buildDailyBrief([task], NOW);
    expect(brief.waitingOnOthers.map((t) => t.id)).toContain(task.id);

    // Once Suresh confirms (status -> done), it must disappear from Waiting,
    // exactly as production evidence showed.
    const confirmed = makeTask({ ...task, status: "done", confirmed_at: NOW.toISOString() });
    const briefAfter = buildDailyBrief([confirmed], NOW);
    expect(briefAfter.waitingOnOthers.map((t) => t.id)).not.toContain(confirmed.id);
  });
});
