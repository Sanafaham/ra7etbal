import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(__dirname, "Confirm.tsx"), "utf-8");

/**
 * UX regression: before any proof photo existed, the disabled submit button
 * said "Attach a new photo to continue" — confusing manual testing, since
 * "new photo" implies a prior photo exists to replace. `needsNewProof` is
 * true both for a task's first-ever proof (proofRequired, no outcome yet)
 * and for a post-rejection re-upload (outcome correction_required /
 * fraud_suspected). Only the second case genuinely involves a replacement
 * photo, so the button copy must distinguish the two. The upload control
 * already handled this correctly ("Attach proof photo" vs. "Add another
 * photo" based on proofPhotos.length) — this only fixes the submit button.
 */
describe("Confirm.tsx — proof photo button copy before/after a first photo", () => {
  const submitButtonBlock = SOURCE.slice(
    SOURCE.indexOf("onClick={() => void handleConfirm()}"),
    SOURCE.indexOf("</button>", SOURCE.indexOf("onClick={() => void handleConfirm()}")),
  );

  it("says 'Attach proof photo to continue' for a first-ever proof (no rejection yet)", () => {
    expect(submitButtonBlock).toContain('"Attach proof photo to continue"');
  });

  it("still says 'Attach a new photo to continue' only for a genuine post-rejection re-upload", () => {
    expect(submitButtonBlock).toMatch(
      /outcome === "correction_required" \|\| outcome === "fraud_suspected"\s*\n\s*\? "Attach a new photo to continue"/,
    );
  });

  it("the upload control already avoids 'new'/'another' language before any photo exists", () => {
    const uploadControlBlock = SOURCE.slice(
      SOURCE.indexOf('onClick={() => fileInputRef.current?.click()}'),
      SOURCE.indexOf("</button>", SOURCE.indexOf('onClick={() => fileInputRef.current?.click()}')),
    );
    expect(uploadControlBlock).toContain('proofPhotos.length > 0 ? "Add another photo" : "Attach proof photo"');
  });

  it("does not leave any bare/unconditional 'Attach a new photo to continue' string", () => {
    // Guards against a future edit accidentally reverting to the
    // unconditional string outside the outcome-gated ternary branch.
    const occurrences = SOURCE.match(/"Attach a new photo to continue"/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});
