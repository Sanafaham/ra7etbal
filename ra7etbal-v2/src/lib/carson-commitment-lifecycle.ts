/**
 * Carson Commitment Lifecycle — Constitutional Gate Layer
 *
 * Implements the application-layer gates for COS Ch. 13 Commitment Lifecycle,
 * Amendments S2 and S3 (Frozen 2026-08-01).
 *
 * Amendment S2: A commitment in the Indeterminate state must be immediately
 * registered with Open Loop Governance. Indeterminate is not a resting state.
 *
 * Amendment S3: Reopening a Verified Complete commitment (status = 'done')
 * requires explicit owner authorisation or new verified evidence from
 * Epistemic Governance.
 *
 * The database-layer enforcement lives in:
 *   supabase/migrations/20260801_commitment_lifecycle_s2_s3.sql
 */

// ─── Amendment S3 — Authority gate on Verified Complete → Authorized ───────

/**
 * The source of authority that permits reopening a Verified Complete
 * commitment. Both sources satisfy Amendment S3.
 *
 * - owner_explicit: The owner directly authorised the reopen (voice command,
 *   UI action, or explicit WhatsApp instruction).
 * - epistemic_evidence: Epistemic Governance supplied new verified evidence
 *   that materially contradicts the basis for completion (Ch. 5 / Ch. 19).
 */
export type ReopenAuthSource = "owner_explicit" | "epistemic_evidence";

export interface ReopenAuthority {
  source: ReopenAuthSource;
  /** Optional human-readable rationale for the reopen. */
  rationale?: string;
}

export class ReopenAuthError extends Error {
  readonly code = "reopen_requires_authorization";
  constructor(detail?: string) {
    super(
      "Reopening a completed commitment requires explicit owner authorisation " +
        "or new verified evidence from Epistemic Governance (COS Ch. 13.5 " +
        "Amendment S3)." +
        (detail ? ` Detail: ${detail}` : ""),
    );
    this.name = "ReopenAuthError";
  }
}

/**
 * True when the commitment has reached Verified Complete (status = 'done').
 * Maps to the Verified Complete terminal state in COS Ch. 13.4.
 */
export function isVerifiedComplete(task: { status: string }): boolean {
  return task.status === "done";
}

/**
 * Validates that a transition from Verified Complete to Authorized (Reopened)
 * is constitutionally authorised.
 *
 * Throws ReopenAuthError if the commitment is Verified Complete but the
 * provided authority is invalid. No-ops if the commitment is not done.
 *
 * COS Ch. 13.5 Amendment S3.
 */
export function validateReopenTransition(
  task: { status: string },
  auth: ReopenAuthority,
): void {
  if (!isVerifiedComplete(task)) return;
  if (auth.source !== "owner_explicit" && auth.source !== "epistemic_evidence") {
    throw new ReopenAuthError(`unsupported authority source: ${String(auth.source)}`);
  }
}

// ─── Amendment S2 — Indeterminate state detection ───────────────────────────

/**
 * Quality review statuses that map to the Indeterminate commitment state
 * in COS Ch. 13.4.
 *
 * - uncertain: proof submitted but outcome cannot be determined automatically;
 *   owner review is required.
 * - fraud_suspected: proof appears fraudulent; repeated automated retries
 *   exhausted; owner input is required.
 *
 * Both states mean the commitment cannot safely advance to a terminal state
 * without further evidence — the constitutional definition of Indeterminate.
 */
export const INDETERMINATE_REVIEW_STATUSES = new Set([
  "uncertain",
  "fraud_suspected",
] as const);

export type IndeterminateReviewStatus = "uncertain" | "fraud_suspected";

/** How long (ms) before OLG sends a follow-up push for an unresolved Indeterminate task. */
export const UNCERTAIN_OLG_FOLLOW_UP_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * True when the task is in an Indeterminate commitment state per COS Ch. 13.4.
 *
 * Indeterminate = commitment cannot advance to a terminal state without further
 * evidence. In Ra7etBal this maps to: status is pending AND the quality review
 * outcome is uncertain or fraud_suspected.
 */
export function isIndeterminateCommitment(task: {
  status: string;
  quality_review_status: string | null | undefined;
}): boolean {
  return (
    task.status === "pending" &&
    INDETERMINATE_REVIEW_STATUSES.has(
      (task.quality_review_status ?? "") as IndeterminateReviewStatus,
    )
  );
}
