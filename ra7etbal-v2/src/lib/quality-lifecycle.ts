import type { Task } from "../types/task";

export type QualityLifecycleState =
  | "not_quality_tracked"
  | "waiting_for_confirmation"
  | "proof_submitted"
  | "needs_owner_review"
  | "completed";

export type QualityLifecycleBadge =
  | "Waiting for confirmation"
  | "Proof submitted"
  | "Needs your review"
  | "Completed";

export interface QualityLifecycle {
  state: QualityLifecycleState;
  badge: QualityLifecycleBadge | null;
  hasActiveBadge: boolean;
  requiresNewProof: boolean;
  blocksGenericFollowup: boolean;
  needsOwnerReview: boolean;
}

type QualityTaskInput = Pick<
  Task,
  "type" | "status" | "assigned_to" | "confirmation_url" | "proof_image_path" | "quality_review_status"
>;

function normalizeReviewStatus(status: Task["quality_review_status"] | string | null | undefined): string {
  return typeof status === "string" ? status.trim().toLowerCase() : "";
}

function isQualityDelegation(task: QualityTaskInput): boolean {
  return task.type === "delegation" && Boolean(task.assigned_to || task.confirmation_url || task.proof_image_path);
}

export function isQualityOwnerReviewStatus(status: Task["quality_review_status"] | string | null | undefined): boolean {
  const normalized = normalizeReviewStatus(status);
  return normalized === "uncertain";
}

export function isQualityFlaggedStatus(status: Task["quality_review_status"] | string | null | undefined): boolean {
  const normalized = normalizeReviewStatus(status);
  return (
    normalized === "correction_required" ||
    normalized === "fraud_suspected"
  );
}

export function resolveQualityLifecycle(task: QualityTaskInput): QualityLifecycle {
  if (!isQualityDelegation(task)) {
    return {
      state: "not_quality_tracked",
      badge: null,
      hasActiveBadge: false,
      requiresNewProof: false,
      blocksGenericFollowup: false,
      needsOwnerReview: false,
    };
  }

  const reviewStatus = normalizeReviewStatus(task.quality_review_status);
  const hasProof = Boolean(task.proof_image_path);
  const isCompleted = task.status === "done" || reviewStatus === "approved";

  if (isCompleted) {
    return {
      state: "completed",
      badge: "Completed",
      hasActiveBadge: true,
      requiresNewProof: false,
      blocksGenericFollowup: false,
      needsOwnerReview: false,
    };
  }

  if (hasProof && isQualityOwnerReviewStatus(reviewStatus)) {
    return {
      state: "needs_owner_review",
      badge: "Needs your review",
      hasActiveBadge: true,
      requiresNewProof: false,
      blocksGenericFollowup: true,
      needsOwnerReview: true,
    };
  }

  if (hasProof && isQualityFlaggedStatus(reviewStatus)) {
    return {
      state: "waiting_for_confirmation",
      badge: "Waiting for confirmation",
      hasActiveBadge: true,
      requiresNewProof: true,
      blocksGenericFollowup: true,
      needsOwnerReview: false,
    };
  }

  if (hasProof) {
    return {
      state: "proof_submitted",
      badge: "Proof submitted",
      hasActiveBadge: true,
      requiresNewProof: false,
      blocksGenericFollowup: true,
      needsOwnerReview: false,
    };
  }

  return {
    state: "waiting_for_confirmation",
    badge: "Waiting for confirmation",
    hasActiveBadge: true,
    requiresNewProof: isQualityFlaggedStatus(reviewStatus),
    blocksGenericFollowup: reviewStatus !== "" && reviewStatus !== "approved",
    needsOwnerReview: false,
  };
}
