import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Confirm.tsx"), "utf-8");

/**
 * Production incident: Christopher uploaded the wrong proof photo (correctly
 * flagged — "correction_required"), then uploaded a corrected photo. Carson's
 * review came back "uncertain" and the confirm page correctly said "sent to
 * the owner for a quick review" for that same page visit. But `outcome` only
 * ever lived in local React state, seeded from the POST response — it was
 * never derived from anything persisted. Reopening the exact same WhatsApp
 * link (a fresh GET, `outcome` starting at null again) fell straight through
 * to the ordinary upload form, letting Christopher upload yet another photo
 * indefinitely instead of showing the locked "submitted for owner review"
 * state. Root cause: GET /api/task-confirm never returned the persisted
 * quality_review_status at all, so the client had no way to know.
 */
describe("Confirm — reopening the link after proof review uses the persisted state", () => {
  it("the load effect rehydrates outcome/correctionNote from the server's persisted quality review status", () => {
    const useEffectsSource = SOURCE.slice(SOURCE.indexOf("useEffect(() => {\n    if (!taskId)"));
    const loadEffect = useEffectsSource.slice(0, useEffectsSource.indexOf("\n  }, [taskId]);"));
    expect(loadEffect).toContain("qualityReviewStatus: data.qualityReviewStatus ?? null");
    expect(loadEffect).toContain("qualityReviewNote: data.qualityReviewNote ?? null");
    expect(loadEffect).toContain("if (data.qualityReviewStatus) {");
    expect(loadEffect).toContain("setOutcome(data.qualityReviewStatus);");
    expect(loadEffect).toContain("setCorrectionNote(data.qualityReviewNote ?? null);");
  });

  it("TaskInfo carries the server's quality review fields as the rehydration source of truth", () => {
    const interfaceBlock = SOURCE.slice(
      SOURCE.indexOf("interface TaskInfo {"),
      SOURCE.indexOf("\n}", SOURCE.indexOf("interface TaskInfo {")),
    );
    expect(interfaceBlock).toContain('| "approved"');
    expect(interfaceBlock).toContain('| "correction_required"');
    expect(interfaceBlock).toContain('| "uncertain"');
    expect(interfaceBlock).toContain('| "fraud_suspected"');
    // Phase 8.1 — narrow additive outcome, added without removing any frozen ones above.
    expect(interfaceBlock).toContain('| "substitute_review"');
    expect(interfaceBlock).toContain("qualityReviewNote: string | null;");
  });

  it("an uncertain outcome (hydrated or fresh) renders the owner-review message, not the upload form", () => {
    // Both branches must resolve BEFORE the upload-form fallthrough — order
    // matters, since this is a ternary chain, not independent conditionals.
    const doneIdx = SOURCE.indexOf('info.status === "done" ?');
    const uncertainIdx = SOURCE.indexOf('outcome === "uncertain" ?');
    const uploadSectionIdx = SOURCE.indexOf('{/* Proof photo section — shown before Mark done */}');
    expect(doneIdx).toBeGreaterThan(-1);
    expect(uncertainIdx).toBeGreaterThan(doneIdx);
    expect(uploadSectionIdx).toBeGreaterThan(uncertainIdx);
    expect(SOURCE.slice(uncertainIdx, uploadSectionIdx)).toContain(
      "Thanks — this has been sent to the owner for a quick review.",
    );
  });

  it("a fraud_suspected outcome stays in the correction upload flow, not owner review", () => {
    const uploadSectionIdx = SOURCE.indexOf('{/* Proof photo section — shown before Mark done */}');
    const correctionBannerIdx = SOURCE.indexOf('(outcome === "correction_required" || outcome === "fraud_suspected")');
    const uploadBranch = SOURCE.slice(correctionBannerIdx, uploadSectionIdx);
    expect(correctionBannerIdx).toBeGreaterThan(-1);
    expect(uploadBranch).toContain('outcome === "fraud_suspected"');
    expect(uploadBranch).toContain("upload new photo(s) below");
    expect(uploadBranch).not.toContain("Thanks — this has been sent to the owner for a quick review.");
    expect(SOURCE).not.toContain("Carson flagged this proof for owner review.");
  });

  it("needsNewProof forces a fresh photo for operational failures, but not true owner review", () => {
    const needsNewProofIdx = SOURCE.indexOf("const needsNewProof =");
    const needsNewProofBlock = SOURCE.slice(needsNewProofIdx, SOURCE.indexOf(";", SOURCE.indexOf("proofPhotos.length === 0", needsNewProofIdx)) + 1);
    expect(needsNewProofBlock).toContain('outcome !== "uncertain"');
    expect(needsNewProofBlock).toContain('outcome === "fraud_suspected"');
    expect(needsNewProofBlock).toContain('outcome === "correction_required"');
  });

  it("protected: correction_required is NOT treated as locked — the recipient can still resubmit", () => {
    const uncertainIdx = SOURCE.indexOf('outcome === "uncertain" ?');
    const correctionIdx = SOURCE.indexOf('outcome === "correction_required"', uncertainIdx);
    const uncertainBranch = SOURCE.slice(uncertainIdx, correctionIdx);
    expect(uncertainBranch).not.toContain("correction_required");
    expect(correctionIdx).toBeGreaterThan(uncertainIdx);
    expect(SOURCE.slice(correctionIdx, SOURCE.indexOf('{/* Proof photo section', correctionIdx))).not.toContain(
      "Thanks — this has been sent to the owner for a quick review.",
    );
  });
});
