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

  it("shows owner-review status instead of waiting-for-confirmation once proof has been submitted", () => {
    expect(SOURCE).toContain("const isProofSubmittedForOwnerReview = isWaitingDelegation && Boolean(");
    expect(SOURCE).toContain("task.proof_image_path &&");
    expect(SOURCE).toContain('task.quality_review_status !== "approved"');
    expect(SOURCE).toContain('task.quality_review_status !== "correction_required"');
    expect(SOURCE).toContain("Proof needs review");

    const headerBlock = SOURCE.slice(
      SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">'),
      SOURCE.indexOf("{reminderDue?.overdue", SOURCE.indexOf('<div className="flex items-center gap-2 text-xs text-ink/55">')),
    );
    expect(headerBlock.indexOf("isProofSubmittedForOwnerReview")).toBeGreaterThan(-1);
    expect(headerBlock.indexOf("Waiting for confirmation")).toBeGreaterThan(
      headerBlock.indexOf("isProofSubmittedForOwnerReview"),
    );
    expect(headerBlock).toContain("!task.proof_image_path");
  });

  it("normal pending delegations still show waiting-for-confirmation, while confirmed tasks use done copy", () => {
    expect(SOURCE).toContain('isWaitingDelegation && task.confirmation_url && !task.proof_image_path');
    expect(SOURCE).toContain("Waiting for confirmation");
    expect(SOURCE).toContain("Confirmed done");
  });
});
