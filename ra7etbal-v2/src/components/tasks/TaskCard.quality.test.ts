import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "TaskCard.tsx"), "utf-8");

describe("TaskCard — Quality Intelligence owner surface", () => {
  it("does not show correction-required proof or status on owner active cards", () => {
    expect(SOURCE).toContain('const isCorrectionRequired = task.quality_review_status === "correction_required"');
    expect(SOURCE).toContain("const showProofImage = Boolean(signedProofImageUrl && !isCorrectionRequired)");
    expect(SOURCE).not.toContain('task.quality_review_status === "correction_required" && (');
    expect(SOURCE).not.toContain("Correction requested");
  });

  it("keeps owner-review states visible for uncertain and fraud-suspected proof", () => {
    expect(SOURCE).toContain('task.quality_review_status === "uncertain"');
    expect(SOURCE).toContain('task.quality_review_status === "fraud_suspected"');
    expect(SOURCE).toContain("Carson is unsure");
    expect(SOURCE).toContain("Possible issue with this proof photo");
  });

  it("flagged proof shows Needs your review", () => {
    expect(SOURCE).toContain("const isFlaggedProofForOwnerReview = isWaitingDelegation && hasSubmittedProof && (");
    expect(SOURCE).toContain('task.quality_review_status === "correction_required"');
    expect(SOURCE).toContain("Needs your review");
  });

  it("suspicious proof shows Needs your review", () => {
    expect(SOURCE).toContain("const isFlaggedProofForOwnerReview = isWaitingDelegation && hasSubmittedProof && (");
    expect(SOURCE).toContain('task.quality_review_status === "fraud_suspected"');
    expect(SOURCE).toContain("Needs your review");

    const headerBlock = SOURCE.slice(
      SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">'),
      SOURCE.indexOf("{reminderDue?.overdue", SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">')),
    );
    expect(headerBlock.indexOf("isFlaggedProofForOwnerReview")).toBeGreaterThan(-1);
    expect(headerBlock.indexOf("Proof submitted")).toBeGreaterThan(
      headerBlock.indexOf("isFlaggedProofForOwnerReview"),
    );
  });

  it("normal submitted proof shows proof-submitted language instead of waiting-for-confirmation", () => {
    expect(SOURCE).toContain("const hasSubmittedProof = Boolean(task.proof_image_path)");
    expect(SOURCE).toContain("const isProofSubmittedForOwnerReview = isWaitingDelegation && hasSubmittedProof && (");
    expect(SOURCE).toContain('task.quality_review_status !== "approved"');
    expect(SOURCE).toContain("!isFlaggedProofForOwnerReview");
    expect(SOURCE).toContain("Proof submitted");

    const headerBlock = SOURCE.slice(
      SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">'),
      SOURCE.indexOf("{reminderDue?.overdue", SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">')),
    );
    expect(headerBlock.indexOf("isProofSubmittedForOwnerReview")).toBeGreaterThan(-1);
    expect(headerBlock.indexOf("Waiting for confirmation")).toBeGreaterThan(
      headerBlock.indexOf("isProofSubmittedForOwnerReview"),
    );
    expect(headerBlock).toContain("!hasSubmittedProof");
  });

  it("normal pending delegations still show waiting-for-confirmation, while confirmed tasks use done copy", () => {
    expect(SOURCE).toContain("isWaitingDelegation && task.confirmation_url && !hasSubmittedProof");
    expect(SOURCE).toContain("Waiting for confirmation");
    expect(SOURCE).toContain("Confirmed done");
  });

  it("no proof submitted shows Waiting for confirmation", () => {
    const headerBlock = SOURCE.slice(
      SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">'),
      SOURCE.indexOf("{reminderDue?.overdue", SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">')),
    );
    expect(headerBlock).toContain("isWaitingDelegation && task.confirmation_url && !hasSubmittedProof");
    expect(headerBlock).toContain("Waiting for confirmation");
  });
});
