/**
 * Tests for Carson Commitment Lifecycle Constitutional Gates
 *
 * COS Ch. 13.5:
 * - Amendment S2: Indeterminate state detection and OLG registration.
 * - Amendment S3: Authority gate on Verified Complete → Authorized (Reopened).
 */

import { describe, it, expect } from "vitest";
import {
  isVerifiedComplete,
  validateReopenTransition,
  isIndeterminateCommitment,
  ReopenAuthError,
  UNCERTAIN_OLG_FOLLOW_UP_MS,
  INDETERMINATE_REVIEW_STATUSES,
} from "./carson-commitment-lifecycle";

// ─── S3: isVerifiedComplete ─────────────────────────────────────────────────

describe("isVerifiedComplete", () => {
  it("returns true for a done task", () => {
    expect(isVerifiedComplete({ status: "done" })).toBe(true);
  });

  it("returns false for a pending task", () => {
    expect(isVerifiedComplete({ status: "pending" })).toBe(false);
  });

  it("returns false for a cancelled task", () => {
    expect(isVerifiedComplete({ status: "cancelled" })).toBe(false);
  });
});

// ─── S3: validateReopenTransition ──────────────────────────────────────────

describe("validateReopenTransition — Verified Complete gate", () => {
  it("does not throw when task is pending (no gate needed)", () => {
    expect(() =>
      validateReopenTransition({ status: "pending" }, { source: "owner_explicit" }),
    ).not.toThrow();
  });

  it("does not throw when task is cancelled (not a terminal completion)", () => {
    expect(() =>
      validateReopenTransition({ status: "cancelled" }, { source: "owner_explicit" }),
    ).not.toThrow();
  });

  it("does not throw for a done task with owner_explicit authority", () => {
    expect(() =>
      validateReopenTransition({ status: "done" }, { source: "owner_explicit" }),
    ).not.toThrow();
  });

  it("does not throw for a done task with epistemic_evidence authority", () => {
    expect(() =>
      validateReopenTransition(
        { status: "done" },
        { source: "epistemic_evidence", rationale: "New proof contradicts completion" },
      ),
    ).not.toThrow();
  });

  it("throws ReopenAuthError when a done task has no valid authority source", () => {
    expect(() =>
      // @ts-expect-error — testing invalid source
      validateReopenTransition({ status: "done" }, { source: "unrecognized" }),
    ).toThrow(ReopenAuthError);
  });

  it("thrown error has code 'reopen_requires_authorization'", () => {
    try {
      // @ts-expect-error — testing invalid source
      validateReopenTransition({ status: "done" }, { source: "invalid" });
    } catch (err) {
      expect(err).toBeInstanceOf(ReopenAuthError);
      expect((err as ReopenAuthError).code).toBe("reopen_requires_authorization");
    }
  });

  it("thrown error message references COS Ch. 13.5 Amendment S3", () => {
    try {
      // @ts-expect-error — testing invalid source
      validateReopenTransition({ status: "done" }, { source: "bad" });
    } catch (err) {
      expect((err as Error).message).toContain("Amendment S3");
    }
  });

  it("accepts optional rationale without affecting the outcome", () => {
    expect(() =>
      validateReopenTransition(
        { status: "done" },
        { source: "owner_explicit", rationale: "Owner requested reopen during voice call" },
      ),
    ).not.toThrow();
  });
});

// ─── S2: isIndeterminateCommitment ─────────────────────────────────────────

describe("isIndeterminateCommitment", () => {
  it("returns true for pending + uncertain", () => {
    expect(
      isIndeterminateCommitment({ status: "pending", quality_review_status: "uncertain" }),
    ).toBe(true);
  });

  it("returns true for pending + fraud_suspected", () => {
    expect(
      isIndeterminateCommitment({ status: "pending", quality_review_status: "fraud_suspected" }),
    ).toBe(true);
  });

  it("returns false for done + uncertain (task already at terminal state)", () => {
    expect(
      isIndeterminateCommitment({ status: "done", quality_review_status: "uncertain" }),
    ).toBe(false);
  });

  it("returns false for pending + approved (not indeterminate)", () => {
    expect(
      isIndeterminateCommitment({ status: "pending", quality_review_status: "approved" }),
    ).toBe(false);
  });

  it("returns false for pending + correction_required (Carson's operational loop, not Indeterminate)", () => {
    expect(
      isIndeterminateCommitment({ status: "pending", quality_review_status: "correction_required" }),
    ).toBe(false);
  });

  it("returns false for pending + substitute_review (owner decision pending, not Indeterminate)", () => {
    expect(
      isIndeterminateCommitment({ status: "pending", quality_review_status: "substitute_review" }),
    ).toBe(false);
  });

  it("returns false for pending with null quality_review_status (not yet reviewed)", () => {
    expect(
      isIndeterminateCommitment({ status: "pending", quality_review_status: null }),
    ).toBe(false);
  });

  it("returns false for cancelled + uncertain", () => {
    expect(
      isIndeterminateCommitment({ status: "cancelled", quality_review_status: "uncertain" }),
    ).toBe(false);
  });
});

// ─── S2: Constants ──────────────────────────────────────────────────────────

describe("S2 constants", () => {
  it("UNCERTAIN_OLG_FOLLOW_UP_MS is 4 hours", () => {
    expect(UNCERTAIN_OLG_FOLLOW_UP_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("INDETERMINATE_REVIEW_STATUSES contains uncertain and fraud_suspected only", () => {
    expect(INDETERMINATE_REVIEW_STATUSES.has("uncertain")).toBe(true);
    expect(INDETERMINATE_REVIEW_STATUSES.has("fraud_suspected")).toBe(true);
    expect(INDETERMINATE_REVIEW_STATUSES.size).toBe(2);
  });
});
