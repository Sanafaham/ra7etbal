import { describe, expect, it } from "vitest";
import { resolveQualityLifecycle } from "./quality-lifecycle";
import type { Task } from "../types/task";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    description: "plate the chicken",
    type: "delegation",
    assigned_to: "Christopher",
    status: "pending",
    needs_follow_up: true,
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

const ACTIVE_BADGES = [
  "Waiting for confirmation",
  "Proof submitted",
  "Needs your review",
  "Completed",
] as const;

describe("Quality Intelligence lifecycle state machine", () => {
  it("always resolves to exactly one active lifecycle badge for QI delegations", () => {
    const cases = [
      task(),
      task({ proof_image_path: "task-images/u/t/proof/0.jpg" }),
      task({ proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: "uncertain" }),
      task({ proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: "fraud_suspected" }),
      task({ proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: "correction_required" }),
      task({ status: "done", proof_image_path: "task-images/u/t/proof/0.jpg", quality_review_status: "approved" }),
    ];

    for (const item of cases) {
      const lifecycle = resolveQualityLifecycle(item);
      const activeCount = ACTIVE_BADGES.filter((badge) => lifecycle.badge === badge).length;
      expect(activeCount).toBe(1);
      expect(lifecycle.hasActiveBadge).toBe(true);
    }
  });

  it("no proof submitted shows Waiting for confirmation", () => {
    expect(resolveQualityLifecycle(task()).badge).toBe("Waiting for confirmation");
  });

  it("proof submitted never shows Waiting for confirmation", () => {
    const lifecycle = resolveQualityLifecycle(task({
      proof_image_path: "task-images/u/t/proof/0.jpg",
      quality_review_status: null,
    }));

    expect(lifecycle.badge).toBe("Proof submitted");
    expect(lifecycle.badge).not.toBe("Waiting for confirmation");
  });

  it("flagged and suspicious proof stay Waiting for worker correction, not owner review", () => {
    for (const quality_review_status of ["correction_required", "fraud_suspected"] as const) {
      const lifecycle = resolveQualityLifecycle(task({
        proof_image_path: "task-images/u/t/proof/0.jpg",
        quality_review_status,
      }));

      expect(lifecycle.badge).toBe("Waiting for confirmation");
      expect(lifecycle.badge).not.toBe("Proof submitted");
      expect(lifecycle.requiresNewProof).toBe(true);
      expect(lifecycle.blocksGenericFollowup).toBe(true);
      expect(lifecycle.needsOwnerReview).toBe(false);
    }
  });

  it("approved proof cannot return to review", () => {
    const lifecycle = resolveQualityLifecycle(task({
      status: "pending",
      proof_image_path: "task-images/u/t/proof/0.jpg",
      quality_review_status: "approved",
    }));

    expect(lifecycle.badge).toBe("Completed");
    expect(lifecycle.needsOwnerReview).toBe(false);
    expect(lifecycle.requiresNewProof).toBe(false);
  });

  it("completed task cannot return to waiting", () => {
    const lifecycle = resolveQualityLifecycle(task({
      status: "done",
      proof_image_path: null,
      quality_review_status: null,
    }));

    expect(lifecycle.badge).toBe("Completed");
    expect(lifecycle.badge).not.toBe("Waiting for confirmation");
  });

  it("correction_required returns to waiting for new proof only", () => {
    const lifecycle = resolveQualityLifecycle(task({
      proof_image_path: "task-images/u/t/proof/0.jpg",
      quality_review_status: "correction_required",
    }));

    expect(lifecycle.badge).toBe("Waiting for confirmation");
    expect(lifecycle.requiresNewProof).toBe(true);
    expect(lifecycle.blocksGenericFollowup).toBe(true);
    expect(lifecycle.needsOwnerReview).toBe(false);
  });

  it("uncertain proof is the owner-review escalation state", () => {
    const lifecycle = resolveQualityLifecycle(task({
      proof_image_path: "task-images/u/t/proof/0.jpg",
      quality_review_status: "uncertain",
    }));

    expect(lifecycle.badge).toBe("Needs your review");
    expect(lifecycle.requiresNewProof).toBe(false);
    expect(lifecycle.blocksGenericFollowup).toBe(true);
    expect(lifecycle.needsOwnerReview).toBe(true);
  });
});
